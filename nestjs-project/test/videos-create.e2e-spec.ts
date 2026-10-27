import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { registerConfirmAndLogin } from '../src/test/e2e-auth';
import { deleteObjectsByPrefix } from '../src/test/storage';
import { Video } from '../src/videos/entities/video.entity';
import storageConfig from '../src/config/storage.config';
import type { ConfigType } from '@nestjs/config';

interface VideoResponseBody {
  id: string;
  title: string;
  status: string;
  part_size: number;
  part_count: number;
  error: string;
  message: unknown;
}

const bodyOf = (res: request.Response) => res.body as VideoResponseBody;

describe('videos-create (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let token: string;

  const validBody = {
    title: 'My video',
    file_name: 'clip.mp4',
    file_size: 11534336,
    mime_type: 'video/mp4',
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    videos = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    storage = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    token = await registerConfirmAndLogin(app, 'owner@example.com');
  });

  afterEach(async () => {
    // Abort any multipart upload still open so MinIO does not accumulate parts.
    for (const video of await videos.find()) {
      if (video.upload_id) {
        await storage.abortMultipartUpload(video.storage_key, video.upload_id);
      }
    }
    const config = app.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
    await deleteObjectsByPrefix(
      app.get(S3_INTERNAL_CLIENT),
      config.bucket,
      'videos/',
    );
  });

  const post = (body: object, auth: string | null = token) => {
    const req = request(app.getHttpServer()).post('/videos');
    return (auth ? req.set('Authorization', `Bearer ${auth}`) : req).send(body);
  };

  describe('POST /videos', () => {
    it('creates-draft-and-returns-part-plan', async () => {
      const res = await post(validBody).expect(201);

      expect(bodyOf(res).id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(bodyOf(res).title).toBe('My video');
      expect(bodyOf(res).status).toBe('draft');
      expect(bodyOf(res).part_size).toBe(5242880);
      expect(bodyOf(res).part_count).toBe(3);

      const row = await videos.findOneByOrFail({ public_id: bodyOf(res).id });
      const channel = await dataSource
        .getRepository(Channel)
        .findOneByOrFail({ nickname: 'owner' });
      expect(row.status).toBe('draft');
      expect(row.channel_id).toBe(channel.id);
      expect(row.upload_id).not.toBeNull();
      expect(row.storage_key).toBe(`videos/${row.id}/original.mp4`);
      expect(row.declared_size).toBe(11534336);
      expect(row.mime_type).toBe('video/mp4');
      expect(row.original_file_name).toBe('clip.mp4');
    });

    it('accepts-the-10-gib-maximum-declared-size', async () => {
      const res = await post({ ...validBody, file_size: 10737418240 }).expect(
        201,
      );

      expect(bodyOf(res).part_count).toBe(
        Math.ceil(10737418240 / bodyOf(res).part_size),
      );
      expect(bodyOf(res).part_count).toBeLessThanOrEqual(10000);
    });

    it('rejects-file-size-above-10-gib', async () => {
      const res = await post({ ...validBody, file_size: 10737418241 }).expect(
        400,
      );

      expect(bodyOf(res).error).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(bodyOf(res).message)).toContain('file_size');
      expect(await videos.count()).toBe(0);
    });

    it('rejects-unsupported-mime-type', async () => {
      const res = await post({
        ...validBody,
        mime_type: 'video/quicktime',
      }).expect(400);

      expect(bodyOf(res).error).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(bodyOf(res).message)).toContain('mime_type');
      expect(await videos.count()).toBe(0);
    });

    it('requires-authentication', async () => {
      await post(validBody, null).expect(401);

      expect(await videos.count()).toBe(0);
    });

    it('generates-distinct-public-ids', async () => {
      const first = await post(validBody).expect(201);
      const second = await post(validBody).expect(201);

      expect(bodyOf(first).id).not.toBe(bodyOf(second).id);
      expect(await videos.count()).toBe(2);
    });

    it('not-rate-limited-by-auth-throttler', async () => {
      for (let i = 0; i < 12; i++) {
        await post(validBody).expect(201);
      }
    });
  });
});
