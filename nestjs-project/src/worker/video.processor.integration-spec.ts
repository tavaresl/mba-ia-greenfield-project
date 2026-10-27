import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { MediaProcessingError } from '../media/media.errors';
import { MediaModule } from '../media/media.module';
import { S3_INTERNAL_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { deleteObjectsByPrefix } from '../test/storage';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../videos/video-processing.constants';
import { VideoProcessingProducer } from '../videos/video-processing.producer';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

async function waitFor<T>(
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 20000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

// Runs the real VideoProcessor on a real BullMQ worker (QUEUE_PREFIX=test, so
// the running video-worker never sees these jobs). Needs ffmpeg: video-worker.
describe('VideoProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videos: Repository<Video>;
  let storage: StorageService;
  let ffmpeg: FfmpegService;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;
  let fixtures: MediaFixtures;
  let channelId: string;

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (queueSettings: ConfigType<typeof queueConfig>) => ({
            connection: {
              host: queueSettings.host,
              port: queueSettings.port,
            },
            prefix: queueSettings.prefix,
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        StorageModule,
        MediaModule,
      ],
      providers: [VideoProcessor, VideoProcessingProducer],
    }).compile();
    await module.init();

    dataSource = module.get(DataSource);
    videos = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    ffmpeg = module.get(FfmpegService);
    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
  }, 60000);

  beforeEach(async () => {
    jest.restoreAllMocks();
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'owner@example.com', password: 'hashed' });
    const channel = await dataSource
      .getRepository(Channel)
      .save({ name: 'Owner', nickname: 'owner', user_id: user.id });
    channelId = channel.id;
  });

  afterEach(async () => {
    await deleteObjectsByPrefix(
      module.get(S3_INTERNAL_CLIENT),
      module.get<ConfigType<typeof storageConfig>>(storageConfig.KEY).bucket,
      'videos/',
    );
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await fixtures.cleanup();
    await module.close();
  });

  async function seedVideo(
    file: string,
    status: VideoStatus = VideoStatus.PROCESSING,
    mimeType = 'video/mp4',
  ): Promise<Video> {
    const id = randomUUID();
    const key = `videos/${id}/original.${mimeType === 'video/webm' ? 'webm' : 'mp4'}`;
    await storage.putObject(key, await readFile(file), mimeType);
    return videos.save(
      videos.create({
        id,
        public_id: id.slice(0, 11),
        channel_id: channelId,
        title: 'Seeded',
        status,
        original_file_name: 'clip.mp4',
        mime_type: mimeType,
        declared_size: 1024,
        storage_key: key,
      }),
    );
  }

  const reload = (id: string) => videos.findOneByOrFail({ id });
  const settled = (id: string) =>
    waitFor(async () => {
      const video = await reload(id);
      return video.status === VideoStatus.PROCESSING ? null : video;
    });

  it('should mark a valid MP4 ready with metadata and a stored JPEG thumbnail', async () => {
    const video = await seedVideo(fixtures.h264Mp4);

    await producer.enqueue(video.id);
    const done = await settled(video.id);

    expect(done.status).toBe(VideoStatus.READY);
    expect(done.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(done.duration_seconds).toBeCloseTo(3, 0);
    expect(done).toMatchObject({
      width: 640,
      height: 360,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(done.container_format).toContain('mp4');
    expect(done.bitrate).toBeGreaterThan(0);

    const thumbnailUrl = await storage.presignGetObject(done.thumbnail_key!, {
      signer: 'internal',
      expiresIn: 60,
    });
    const response = await fetch(thumbnailUrl);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('should mark a valid WebM ready', async () => {
    const video = await seedVideo(fixtures.vp9Webm, undefined, 'video/webm');

    await producer.enqueue(video.id);
    const done = await settled(video.id);

    expect(done.status).toBe(VideoStatus.READY);
    expect(done).toMatchObject({ video_codec: 'vp9', audio_codec: 'opus' });
  });

  it('should fail unsupported media as UNSUPPORTED_MEDIA without retrying', async () => {
    const video = await seedVideo(fixtures.mpeg4Mp4);

    await producer.enqueue(video.id);
    const done = await settled(video.id);

    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.failure_reason).toBe('UNSUPPORTED_MEDIA');
    expect(done.thumbnail_key).toBeNull();
    const job = await waitFor(async () => {
      const found = await queue.getJob(video.id);
      return found && (await found.isFailed()) ? found : null;
    });
    expect(job.attemptsMade).toBe(1);
  });

  it('should fail a file that is not media as UNSUPPORTED_MEDIA', async () => {
    const video = await seedVideo(fixtures.textFile);

    await producer.enqueue(video.id);
    const done = await settled(video.id);

    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.failure_reason).toBe('UNSUPPORTED_MEDIA');
  });

  it('should retry a persistent transient error and only fail on the last attempt', async () => {
    const video = await seedVideo(fixtures.h264Mp4);
    const statusesSeen: VideoStatus[] = [];
    jest.spyOn(ffmpeg, 'probe').mockImplementation(async () => {
      statusesSeen.push((await reload(video.id)).status);
      throw new MediaProcessingError('ffprobe timed out');
    });

    // Same contract as the producer, but with a short backoff for the test.
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      {
        jobId: video.id,
        attempts: 3,
        backoff: { type: 'fixed', delay: 50 },
        removeOnFail: false,
      },
    );
    const done = await settled(video.id);

    expect(statusesSeen).toEqual([
      VideoStatus.PROCESSING,
      VideoStatus.PROCESSING,
      VideoStatus.PROCESSING,
    ]);
    expect(done.status).toBe(VideoStatus.FAILED);
    expect(done.failure_reason).toBe('PROCESSING_FAILED');
    const job = await queue.getJob(video.id);
    expect(job!.attemptsMade).toBe(3);
  });

  it.each([VideoStatus.READY, VideoStatus.FAILED])(
    'should leave a %s video untouched when the job is re-delivered',
    async (status) => {
      const video = await seedVideo(fixtures.h264Mp4, status);
      const before = await reload(video.id);
      const probe = jest.spyOn(ffmpeg, 'probe');

      await producer.enqueue(video.id);
      await waitFor(async () => {
        const job = await queue.getJob(video.id);
        return job ? await job.isCompleted() : true;
      });

      const after = await reload(video.id);
      expect(probe).not.toHaveBeenCalled();
      expect(after.status).toBe(status);
      expect(after.updated_at).toEqual(before.updated_at);
    },
  );
});
