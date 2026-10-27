import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
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
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/video-processing.constants';

interface Body {
  id?: string;
  status?: string;
  error?: string;
}
interface UploadedPart {
  part_number: number;
  etag: string;
}

const bodyOf = (res: request.Response) => res.body as Body;

describe('videos-upload-complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let queue: Queue;
  let owner: string;

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
    queue = moduleFixture.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    owner = await registerConfirmAndLogin(app, 'owner@example.com');
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

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${owner}`);

  async function createDraftWithParts(fileSize: number, sizes: number[]) {
    const created = await authed(request(app.getHttpServer()).post('/videos'))
      .send({
        title: 'My video',
        file_name: 'clip.mp4',
        file_size: fileSize,
        mime_type: 'video/mp4',
      })
      .expect(201);
    const publicId = bodyOf(created).id!;

    const signed = await authed(
      request(app.getHttpServer()).post(`/videos/${publicId}/upload/parts`),
    )
      .send({ part_numbers: sizes.map((_, index) => index + 1) })
      .expect(200);
    const parts: UploadedPart[] = [];
    for (const { part_number, url } of (
      signed.body as { parts: { part_number: number; url: string }[] }
    ).parts) {
      const put = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(sizes[part_number - 1])),
      });
      parts.push({ part_number, etag: put.headers.get('etag')! });
    }
    return { publicId, parts };
  }

  const complete = (publicId: string, body: object) =>
    authed(
      request(app.getHttpServer()).post(`/videos/${publicId}/upload/complete`),
    ).send(body);

  describe('POST /videos/:publicId/upload/complete', () => {
    it('completes-upload-and-enqueues-processing', async () => {
      const { publicId, parts } = await createDraftWithParts(
        6291456,
        [5242880, 1048576],
      );

      const res = await complete(publicId, {
        parts: [...parts].reverse(),
      }).expect(202);

      expect(res.body).toEqual({ id: publicId, status: 'processing' });
      const row = await videos.findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.file_size).toBe(6291456);
      expect(row.upload_id).toBeNull();
      await expect(storage.headObject(row.storage_key)).resolves.toEqual({
        contentLength: 6291456,
      });
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].name).toBe('process-video');
      expect(jobs[0].data).toEqual({ videoId: row.id });
    });

    it('rejects-invalid-part-etag', async () => {
      const { publicId, parts } = await createDraftWithParts(
        6291456,
        [5242880, 1048576],
      );

      const res = await complete(publicId, {
        parts: [
          parts[0],
          { ...parts[1], etag: '"00000000000000000000000000000000"' },
        ],
      }).expect(422);

      expect(bodyOf(res).error).toBe('INVALID_UPLOAD_PARTS');
      const row = await videos.findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 0 });
    });

    it('rejects-object-above-max-upload-size', async () => {
      const { publicId, parts } = await createDraftWithParts(
        12582912,
        [5242880, 5242880, 5242880],
      );

      const res = await complete(publicId, { parts }).expect(422);

      expect(bodyOf(res).error).toBe('UPLOAD_SIZE_EXCEEDED');
      const row = await videos.findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.failure_reason).toBe('UPLOAD_SIZE_EXCEEDED');
      await expect(storage.headObject(row.storage_key)).rejects.toBeDefined();
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 0 });
    });

    it('second-complete-is-rejected-without-new-job', async () => {
      const { publicId, parts } = await createDraftWithParts(
        6291456,
        [5242880, 1048576],
      );
      await complete(publicId, { parts }).expect(202);

      const res = await complete(publicId, { parts }).expect(409);

      expect(bodyOf(res).error).toBe('VIDEO_NOT_UPLOADABLE');
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
    });

    it('rejects-missing-parts-array', async () => {
      const { publicId } = await createDraftWithParts(
        6291456,
        [5242880, 1048576],
      );

      const res = await complete(publicId, {}).expect(400);

      expect(bodyOf(res).error).toBe('VALIDATION_ERROR');
      const row = await videos.findOneByOrFail({ public_id: publicId });
      expect(row.status).toBe(VideoStatus.DRAFT);
      expect(row.upload_id).not.toBeNull();
    });
  });
});
