import { randomBytes, randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import storageConfig from '../src/config/storage.config';
import { S3_INTERNAL_CLIENT } from '../src/storage/storage.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { registerConfirmAndLogin } from '../src/test/e2e-auth';
import { deleteObjectsByPrefix } from '../src/test/storage';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';

interface VideoBody {
  status: string;
  error: string;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  container_format: string | null;
  bitrate: number | null;
}

const bodyOf = (res: request.Response) => res.body as VideoBody;
const METADATA_FIELDS = [
  'duration_seconds',
  'width',
  'height',
  'video_codec',
  'audio_codec',
  'container_format',
  'bitrate',
] as const;

describe('videos-read-stream-download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let storage: StorageService;
  let owner: string;
  let stranger: string;
  let ownerChannelId: string;

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
    ownerChannelId = (
      await dataSource.getRepository(Channel).findOneByOrFail({
        nickname: 'owner',
      })
    ).id;
  });

  afterEach(async () => {
    const config = app.get<ConfigType<typeof storageConfig>>(storageConfig.KEY);
    await deleteObjectsByPrefix(
      app.get(S3_INTERNAL_CLIENT),
      config.bucket,
      'videos/',
    );
  });

  // Seeded directly: no worker, queue or FFmpeg involved (see SI-03.11 note).
  async function seedVideo(status: VideoStatus, withThumbnail = false) {
    const id = randomUUID();
    const key = `videos/${id}/original.mp4`;
    const ready = status === VideoStatus.READY;
    if (ready) {
      await storage.putObject(key, randomBytes(4096), 'video/mp4');
    }
    const thumbnailKey = withThumbnail ? `videos/${id}/thumbnail.jpg` : null;
    if (thumbnailKey) {
      await storage.putObject(thumbnailKey, randomBytes(64), 'image/jpeg');
    }
    return videos.save(
      videos.create({
        id,
        public_id: id.slice(0, 11),
        channel_id: ownerChannelId,
        title: 'Seeded',
        status,
        original_file_name: 'my clip.mp4',
        mime_type: 'video/mp4',
        declared_size: 4096,
        storage_key: key,
        ...(ready && {
          file_size: 4096,
          duration_seconds: 3,
          width: 640,
          height: 360,
          video_codec: 'h264',
          audio_codec: 'aac',
          container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
          bitrate: 136781,
          thumbnail_key: thumbnailKey,
        }),
      }),
    );
  }

  const get = (path: string, token: string | null = owner) => {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  it('owner-reads-status-and-metadata', async () => {
    const draft = await seedVideo(VideoStatus.DRAFT);
    const draftRes = await get(`/videos/${draft.public_id}`).expect(200);
    expect(bodyOf(draftRes).status).toBe('draft');
    METADATA_FIELDS.forEach((field) => {
      expect(bodyOf(draftRes)[field]).toBeNull();
    });
    expect(bodyOf(draftRes).thumbnail_url).toBeNull();

    const ready = await seedVideo(VideoStatus.READY, true);
    const readyRes = await get(`/videos/${ready.public_id}`).expect(200);
    const body = bodyOf(readyRes);
    expect(body.status).toBe('ready');
    expect(body).toMatchObject({
      duration_seconds: 3,
      width: 640,
      height: 360,
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 136781,
    });
    expect(body.thumbnail_url).toEqual(expect.stringContaining('http'));
    expect((await fetch(body.thumbnail_url!)).status).toBe(200);
  });

  it('stream-redirects-to-range-capable-url', async () => {
    const video = await seedVideo(VideoStatus.READY);

    const res = await get(`/videos/${video.public_id}/stream`).expect(302);
    const location = res.headers.location;
    expect(location).toBeTruthy();

    const ranged = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-1023/4096');
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);
  });

  it('download-redirects-to-attachment-url', async () => {
    const video = await seedVideo(VideoStatus.READY);

    const res = await get(`/videos/${video.public_id}/download`).expect(302);
    const file = await fetch(res.headers.location);

    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="my clip.mp4"',
    );
  });

  it('stream-and-download-require-ready-video', async () => {
    for (const status of [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.FAILED,
    ]) {
      const video = await seedVideo(status);
      for (const suffix of ['stream', 'download']) {
        const res = await get(`/videos/${video.public_id}/${suffix}`);
        expect(res.status).toBe(409);
        expect(bodyOf(res).error).toBe('VIDEO_NOT_READY');
        expect(res.headers.location).toBeUndefined();
      }
    }
  });

  it('non-owner-and-anonymous-access-denied', async () => {
    const video = await seedVideo(VideoStatus.READY);

    for (const suffix of ['', '/stream', '/download']) {
      const asStranger = await get(
        `/videos/${video.public_id}${suffix}`,
        stranger,
      );
      expect(asStranger.status).toBe(404);
      expect(bodyOf(asStranger).error).toBe('VIDEO_NOT_FOUND');

      const anonymous = await get(`/videos/${video.public_id}${suffix}`, null);
      expect(anonymous.status).toBe(401);
    }
  });
});
