import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { randomBytes, randomUUID } from 'crypto';
import {
  UploadSizeExceededException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let userId: string;
  let channelId: string;
  const uploadsToAbort: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queue: ConfigType<typeof queueConfig>) => ({
            connection: { host: queue.host, port: queue.port },
            prefix: queue.prefix,
          }),
        }),
        VideosModule,
      ],
    }).compile();
    service = module.get(VideosService);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'owner@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'owner',
      user_id: user.id,
    });
    userId = user.id;
    channelId = channel.id;
  });

  afterEach(async () => {
    for (const { key, uploadId } of uploadsToAbort.splice(0)) {
      await storage.abortMultipartUpload(key, uploadId);
    }
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should persist a draft in the caller channel with an open multipart upload', async () => {
    const result = await service.createDraft(userId, {
      title: 'My video',
      file_name: 'clip.webm',
      file_size: 11534336,
      mime_type: 'video/webm',
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.id });
    uploadsToAbort.push({ key: row.storage_key, uploadId: row.upload_id! });

    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.channel_id).toBe(channelId);
    expect(row.title).toBe('My video');
    expect(row.original_file_name).toBe('clip.webm');
    expect(row.mime_type).toBe('video/webm');
    expect(row.declared_size).toBe(11534336);
    expect(row.upload_id).toEqual(expect.any(String));
    expect(row.storage_key).toBe(`videos/${row.id}/original.webm`);
    expect(result).toMatchObject({
      title: 'My video',
      status: 'draft',
      part_size: 5242880,
      part_count: 3,
    });
  });

  it('should leave the open multipart upload listable in storage', async () => {
    const result = await service.createDraft(userId, {
      title: 'Another',
      file_name: 'clip.mp4',
      file_size: 1024,
      mime_type: 'video/mp4',
    });
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.id });
    uploadsToAbort.push({ key: row.storage_key, uploadId: row.upload_id! });

    await expect(
      storage.listParts(row.storage_key, row.upload_id!),
    ).resolves.toEqual([]);
  });

  describe('upload parts and cancellation', () => {
    async function createOwnedDraft(fileSize = 11534336) {
      const created = await service.createDraft(userId, {
        title: 'Resumable',
        file_name: 'clip.mp4',
        file_size: fileSize,
        mime_type: 'video/mp4',
      });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: created.id });
      uploadsToAbort.push({ key: row.storage_key, uploadId: row.upload_id! });
      return row;
    }

    it('should sign a part URL that accepts a PUT and list the part afterwards', async () => {
      const row = await createOwnedDraft();

      const signed = await service.signUploadParts(userId, row.public_id, [1]);
      const response = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(5242880)),
      });
      const listed = await service.listUploadedParts(userId, row.public_id);

      expect(response.status).toBe(200);
      expect(listed.parts).toEqual([
        {
          part_number: 1,
          etag: response.headers.get('etag'),
          size: 5242880,
        },
      ]);
    });

    it('should hide the video from another user', async () => {
      const row = await createOwnedDraft();
      const stranger = await dataSource.getRepository(User).save({
        email: 'stranger@example.com',
        password: 'hashed',
      });
      await dataSource.getRepository(Channel).save({
        name: 'Stranger',
        nickname: 'stranger',
        user_id: stranger.id,
      });

      await expect(
        service.listUploadedParts(stranger.id, row.public_id),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('should abort the multipart upload and delete the row on cancel', async () => {
      const row = await createOwnedDraft();

      await service.cancelUpload(userId, row.public_id);

      await expect(
        dataSource.getRepository(Video).findOneBy({ id: row.id }),
      ).resolves.toBeNull();
      await expect(
        storage.listParts(row.storage_key, row.upload_id!),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('should refuse to cancel a video that is no longer a draft', async () => {
      const row = await createOwnedDraft();
      await dataSource
        .getRepository(Video)
        .update({ id: row.id }, { status: VideoStatus.PROCESSING });

      await expect(
        service.cancelUpload(userId, row.public_id),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });
  });

  describe('completeUpload', () => {
    async function uploadParts(sizes: number[], declared: number) {
      const created = await service.createDraft(userId, {
        title: 'Complete me',
        file_name: 'clip.mp4',
        file_size: declared,
        mime_type: 'video/mp4',
      });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ public_id: created.id });
      uploadsToAbort.push({ key: row.storage_key, uploadId: row.upload_id! });

      const signed = await service.signUploadParts(
        userId,
        row.public_id,
        sizes.map((_, index) => index + 1),
      );
      const parts = await Promise.all(
        signed.parts.map(async ({ part_number, url }) => {
          const response = await fetch(url, {
            method: 'PUT',
            body: new Uint8Array(randomBytes(sizes[part_number - 1])),
          });
          return { part_number, etag: response.headers.get('etag')! };
        }),
      );
      return { row, parts };
    }

    it('should complete out-of-order parts, move to processing and enqueue one job', async () => {
      const { row, parts } = await uploadParts([5242880, 1048576], 6291456);

      const result = await service.completeUpload(
        userId,
        row.public_id,
        [...parts].reverse(),
      );

      const updated = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: row.id });
      expect(result).toEqual({ id: row.public_id, status: 'processing' });
      expect(updated.status).toBe(VideoStatus.PROCESSING);
      expect(updated.file_size).toBe(6291456);
      expect(updated.upload_id).toBeNull();
      await expect(storage.headObject(row.storage_key)).resolves.toEqual({
        contentLength: 6291456,
      });
      const jobs = await queue.getJobs(['waiting']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].data).toEqual({ videoId: row.id });
    });

    it('should delete an object above the size limit and mark the video failed', async () => {
      const { row, parts } = await uploadParts(
        [5242880, 5242880, 5242880],
        12582912,
      );

      await expect(
        service.completeUpload(userId, row.public_id, parts),
      ).rejects.toBeInstanceOf(UploadSizeExceededException);

      const updated = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: row.id });
      expect(updated.status).toBe(VideoStatus.FAILED);
      expect(updated.failure_reason).toBe('UPLOAD_SIZE_EXCEEDED');
      await expect(storage.headObject(row.storage_key)).rejects.toBeDefined();
      expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 0 });
    });
  });

  describe('stream and download URLs', () => {
    async function seedReadyVideo(): Promise<Video> {
      const id = randomUUID();
      const key = `videos/${id}/original.mp4`;
      await storage.putObject(key, randomBytes(4096), 'video/mp4');
      return dataSource.getRepository(Video).save(
        dataSource.getRepository(Video).create({
          id,
          public_id: id.slice(0, 11),
          channel_id: channelId,
          title: 'Ready',
          status: VideoStatus.READY,
          original_file_name: 'my clip.mp4',
          mime_type: 'video/mp4',
          declared_size: 4096,
          file_size: 4096,
          storage_key: key,
        }),
      );
    }

    afterEach(async () => {
      for (const { id } of await dataSource.getRepository(Video).find()) {
        await storage.deleteObject(`videos/${id}/original.mp4`);
      }
    });

    it('should answer a Range request on the stream URL with 206 and 1024 bytes', async () => {
      const video = await seedReadyVideo();

      const url = await service.getStreamUrl(userId, video.public_id);
      const response = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe('bytes 0-1023/4096');
      expect((await response.arrayBuffer()).byteLength).toBe(1024);
    });

    it('should serve the download URL as an attachment with the original name', async () => {
      const video = await seedReadyVideo();

      const url = await service.getDownloadUrl(userId, video.public_id);
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="my clip.mp4"',
      );
    });

    it('should expose the video with a working thumbnail URL', async () => {
      const video = await seedReadyVideo();
      const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
      await storage.putObject(thumbnailKey, randomBytes(64), 'image/jpeg');
      await dataSource
        .getRepository(Video)
        .update({ id: video.id }, { thumbnail_key: thumbnailKey });

      const result = await service.getOwnedVideo(userId, video.public_id);
      const response = await fetch(result.thumbnail_url!);

      expect(result.status).toBe('ready');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/jpeg');
      await storage.deleteObject(thumbnailKey);
    });

    it('should refuse to stream a video that is not ready', async () => {
      const video = await seedReadyVideo();
      await dataSource
        .getRepository(Video)
        .update({ id: video.id }, { status: VideoStatus.PROCESSING });

      await expect(
        service.getStreamUrl(userId, video.public_id),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
    });
  });
});
