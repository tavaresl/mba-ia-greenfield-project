import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue<ProcessVideoJobData>;
  let config: ConfigType<typeof queueConfig>;
  let defaultPrefixQueue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: { host: cfg.host, port: cfg.port },
            prefix: cfg.prefix,
          }),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = module.get(VideoProcessingProducer);
    queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    config = module.get(queueConfig.KEY);
    defaultPrefixQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: { host: config.host, port: config.port },
      prefix: 'bull',
    });
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await defaultPrefixQueue.close();
    await module.close();
  });

  it('should enqueue one process-video job with the contract payload and options', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const jobs = await queue.getJobs(['waiting']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId });
    expect(jobs[0].id).toBe(videoId);
    expect(jobs[0].opts.attempts).toBe(3);
    expect(jobs[0].opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should not create a duplicate job for the same videoId', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
  });

  it('should store jobs under the configured test prefix, not the default one', async () => {
    expect(config.prefix).toBe('test');

    await producer.enqueue(randomUUID());

    expect(await defaultPrefixQueue.getJobCounts('waiting')).toEqual({
      waiting: 0,
    });
  });
});
