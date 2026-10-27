import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import videosConfig from '../config/videos.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { MediaProbeError, MediaProcessingError } from '../media/media.errors';
import type { MediaProbe } from '../media/media.types';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-processing.constants';
import { VideoProcessor } from './video.processor';

const probe: MediaProbe = {
  durationSeconds: 3,
  width: 640,
  height: 360,
  videoCodec: 'h264',
  audioCodec: 'aac',
  containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  bitrate: 120000,
};

function job(attemptsMade = 0, attempts = 3): Job<ProcessVideoJobData> {
  return {
    id: 'video-1',
    data: { videoId: 'video-1' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<ProcessVideoJobData>;
}

describe('VideoProcessor', () => {
  let processor: VideoProcessor;
  const videos = { findOneBy: jest.fn(), update: jest.fn() };
  const storage = { presignGetObject: jest.fn(), putObject: jest.fn() };
  const ffmpeg = { probe: jest.fn(), extractThumbnail: jest.fn() };

  const processingVideo = (overrides: Partial<Video> = {}) =>
    ({
      id: 'video-1',
      status: VideoStatus.PROCESSING,
      mime_type: 'video/mp4',
      storage_key: 'videos/video-1/original.mp4',
      ...overrides,
    }) as Video;

  const processingOnly = { id: 'video-1', status: VideoStatus.PROCESSING };

  beforeEach(async () => {
    jest.clearAllMocks();
    videos.findOneBy.mockResolvedValue(processingVideo());
    videos.update.mockResolvedValue({ affected: 1 });
    storage.presignGetObject.mockResolvedValue('http://minio/signed');
    storage.putObject.mockResolvedValue(undefined);
    ffmpeg.probe.mockResolvedValue(probe);
    ffmpeg.extractThumbnail.mockResolvedValue(Buffer.from([0xff, 0xd8]));

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessor,
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: StorageService, useValue: storage },
        { provide: FfmpegService, useValue: ffmpeg },
        { provide: videosConfig.KEY, useValue: { mediaTimeoutMs: 300000 } },
      ],
    }).compile();
    processor = module.get(VideoProcessor);
  });

  it('should store the thumbnail and mark the video ready with its metadata', async () => {
    await processor.process(job());

    expect(storage.presignGetObject).toHaveBeenCalledWith(
      'videos/video-1/original.mp4',
      expect.objectContaining({ signer: 'internal' }),
    );
    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
      'http://minio/signed',
      1,
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'videos/video-1/thumbnail.jpg',
      Buffer.from([0xff, 0xd8]),
      'image/jpeg',
    );
    expect(videos.update).toHaveBeenCalledTimes(1);
    expect(videos.update).toHaveBeenCalledWith(processingOnly, {
      status: VideoStatus.READY,
      thumbnail_key: 'videos/video-1/thumbnail.jpg',
      duration_seconds: 3,
      width: 640,
      height: 360,
      video_codec: 'h264',
      audio_codec: 'aac',
      container_format: probe.containerFormat,
      bitrate: 120000,
    });
  });

  it('should take the frame at half the duration for very short videos', async () => {
    ffmpeg.probe.mockResolvedValue({ ...probe, durationSeconds: 0.6 });

    await processor.process(job());

    expect(ffmpeg.extractThumbnail).toHaveBeenCalledWith(
      'http://minio/signed',
      0.3,
    );
  });

  it.each([
    ['missing', null],
    ['ready', processingVideo({ status: VideoStatus.READY })],
    ['failed', processingVideo({ status: VideoStatus.FAILED })],
    ['draft', processingVideo({ status: VideoStatus.DRAFT })],
  ])('should do nothing for a %s video', async (_label, video) => {
    videos.findOneBy.mockResolvedValue(video);

    await expect(processor.process(job())).resolves.toBeUndefined();

    expect(ffmpeg.probe).not.toHaveBeenCalled();
    expect(videos.update).not.toHaveBeenCalled();
  });

  it('should fail unsupported media without retries', async () => {
    ffmpeg.probe.mockResolvedValue({ ...probe, videoCodec: 'mpeg4' });

    await expect(processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(videos.update).toHaveBeenCalledWith(processingOnly, {
      status: VideoStatus.FAILED,
      failure_reason: 'UNSUPPORTED_MEDIA',
    });
    expect(ffmpeg.extractThumbnail).not.toHaveBeenCalled();
  });

  it('should fail unreadable media without retries', async () => {
    ffmpeg.probe.mockRejectedValue(new MediaProbeError('not media', 'oops'));

    await expect(processor.process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(videos.update).toHaveBeenCalledWith(processingOnly, {
      status: VideoStatus.FAILED,
      failure_reason: 'UNSUPPORTED_MEDIA',
    });
  });

  it('should rethrow a transient error and keep the status on a non-final attempt', async () => {
    const error = new MediaProcessingError('ffprobe timed out');
    ffmpeg.probe.mockRejectedValue(error);

    await expect(processor.process(job(1, 3))).rejects.toBe(error);

    expect(videos.update).not.toHaveBeenCalled();
  });

  it('should mark the video failed on the final attempt of a transient error', async () => {
    const error = new Error('storage unavailable');
    storage.presignGetObject.mockRejectedValue(error);

    await expect(processor.process(job(2, 3))).rejects.toBe(error);

    expect(videos.update).toHaveBeenCalledWith(processingOnly, {
      status: VideoStatus.FAILED,
      failure_reason: 'PROCESSING_FAILED',
    });
  });

  it('should treat a job without configured attempts as a single attempt', async () => {
    ffmpeg.probe.mockRejectedValue(new MediaProcessingError('boom'));
    const noAttempts = { ...job(), opts: {} } as Job<ProcessVideoJobData>;

    await expect(processor.process(noAttempts)).rejects.toThrow('boom');

    expect(videos.update).toHaveBeenCalledWith(processingOnly, {
      status: VideoStatus.FAILED,
      failure_reason: 'PROCESSING_FAILED',
    });
  });
});
