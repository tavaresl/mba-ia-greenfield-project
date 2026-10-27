import { randomBytes } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { registerConfirmAndLogin } from '../src/test/e2e-auth';
import { deleteObjectsByPrefix } from '../src/test/storage';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface PartsBody {
  parts: { part_number: number; url?: string; etag?: string; size?: number }[];
  expires_in?: number;
  error?: string;
}

const bodyOf = (res: request.Response) => res.body as PartsBody;

describe('videos-upload-parts (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let owner: string;
  let stranger: string;
  let publicId: string;

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
    owner = await registerConfirmAndLogin(app, 'owner@example.com');
    stranger = await registerConfirmAndLogin(app, 'stranger@example.com');

    const created = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${owner}`)
      .send({
        title: 'My video',
        file_name: 'clip.mp4',
        file_size: 11534336,
        mime_type: 'video/mp4',
      })
      .expect(201);
    publicId = (created.body as { id: string }).id;
  });

  afterEach(async () => {
    for (const video of await videos.find()) {
      if (video.upload_id) {
        await storage
          .abortMultipartUpload(video.storage_key, video.upload_id)
          .catch(() => undefined);
      }
    }
    const config = app.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
    await deleteObjectsByPrefix(
      app.get(S3_INTERNAL_CLIENT),
      config.bucket,
      'videos/',
    );
  });

  const call = (
    method: 'post' | 'get' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => {
    const req = request(app.getHttpServer())[method](path);
    req.set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const partsPath = (id = publicId) => `/videos/${id}/upload/parts`;
  const uploadPath = (id = publicId) => `/videos/${id}/upload`;

  describe('upload parts, resume listing and cancellation', () => {
    it('signs-requested-parts', async () => {
      const config = app.get<ConfigType<typeof storageConfig>>(
        storageConfig.KEY,
      );

      const res = await call('post', partsPath(), owner, {
        part_numbers: [1, 2],
      }).expect(200);

      const body = bodyOf(res);
      expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
      body.parts.forEach((part) => {
        expect(part.url).toContain(new URL(config.publicEndpoint).host);
      });
      expect(body.expires_in).toBe(config.uploadUrlTtlSeconds);
    });

    it('uploaded-part-is-listed-for-resume', async () => {
      const signed = await call('post', partsPath(), owner, {
        part_numbers: [1],
      }).expect(200);
      const put = await fetch(bodyOf(signed).parts[0].url!, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(5242880)),
      });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag');
      expect(etag).toBeTruthy();

      const res = await call('get', partsPath(), owner).expect(200);

      expect(bodyOf(res).parts).toEqual([
        { part_number: 1, etag, size: 5242880 },
      ]);
    });

    it('rejects-part-number-above-part-count', async () => {
      const res = await call('post', partsPath(), owner, {
        part_numbers: [4],
      }).expect(400);

      expect(bodyOf(res).error).toBe('VALIDATION_ERROR');
    });

    it('non-owner-gets-not-found', async () => {
      const unknown = 'AAAAAAAAAAA';
      const calls = (token: string, id: string) => [
        () => call('post', partsPath(id), token, { part_numbers: [1] }),
        () => call('get', partsPath(id), token),
        () => call('delete', uploadPath(id), token),
      ];

      for (const [token, id] of [
        [stranger, publicId],
        [owner, unknown],
      ]) {
        for (const send of calls(token, id)) {
          const res = await send();
          expect(res.status).toBe(404);
          expect(bodyOf(res).error).toBe('VIDEO_NOT_FOUND');
        }
      }

      const row = await videos.findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.upload_id).not.toBeNull();
    });

    it('non-draft-video-is-not-uploadable', async () => {
      await videos.update(
        { public_id: publicId },
        { status: VideoStatus.PROCESSING },
      );

      for (const send of [
        () => call('post', partsPath(), owner, { part_numbers: [1] }),
        () => call('get', partsPath(), owner),
        () => call('delete', uploadPath(), owner),
      ]) {
        const res = await send();
        expect(res.status).toBe(409);
        expect(bodyOf(res).error).toBe('VIDEO_NOT_UPLOADABLE');
      }
      expect(await videos.countBy({ public_id: publicId })).toBe(1);
    });

    it('cancel-aborts-upload-and-deletes-draft', async () => {
      const row = await videos.findOneByOrFail({ public_id: publicId });

      await call('delete', uploadPath(), owner).expect(204);

      expect(await videos.countBy({ public_id: publicId })).toBe(0);
      await expect(
        storage.listParts(row.storage_key, row.upload_id!),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });
  });
});
