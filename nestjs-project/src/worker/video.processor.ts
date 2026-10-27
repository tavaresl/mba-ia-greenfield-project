import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError, type Job } from 'bullmq';
import { Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { FfmpegService } from '../media/ffmpeg.service';
import { isSupportedMedia } from '../media/media-format.policy';
import { MediaProbeError } from '../media/media.errors';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from '../videos/video-processing.constants';
import {
  THUMBNAIL_CONTENT_TYPE,
  VIDEO_FAILURE_REASONS,
  thumbnailKeyFor,
} from '../videos/videos.constants';

class UnsupportedMediaError extends Error {
  constructor(videoCodec: string, audioCodec: string | null, mime: string) {
    super(
      `Unsupported media for ${mime}: video=${videoCodec}, audio=${audioCodec ?? 'none'}`,
    );
    this.name = 'UnsupportedMediaError';
  }
}

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    private readonly storage: StorageService,
    private readonly ffmpeg: FfmpegService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const video = await this.videos.findOneBy({ id: job.data.videoId });
    // Re-delivered or stale jobs must not touch a video that already moved on.
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.warn(
        `Skipping job ${job.id}: video ${job.data.videoId} is ${video?.status ?? 'missing'}`,
      );
      return;
    }

    try {
      await this.processVideo(video);
    } catch (error) {
      throw await this.handleFailure(video, job, error);
    }
  }

  private async processVideo(video: Video): Promise<void> {
    // Internal endpoint: the worker reaches storage through the Compose network.
    const inputUrl = await this.storage.presignGetObject(video.storage_key, {
      signer: 'internal',
      expiresIn: Math.ceil(this.config.mediaTimeoutMs / 1000) * 2,
    });

    const probe = await this.ffmpeg.probe(inputUrl);
    if (!isSupportedMedia(probe, video.mime_type)) {
      throw new UnsupportedMediaError(
        probe.videoCodec,
        probe.audioCodec,
        video.mime_type,
      );
    }

    const thumbnail = await this.ffmpeg.extractThumbnail(
      inputUrl,
      Math.min(1, probe.durationSeconds / 2),
    );
    const thumbnailKey = thumbnailKeyFor(video.id);
    await this.storage.putObject(
      thumbnailKey,
      thumbnail,
      THUMBNAIL_CONTENT_TYPE,
    );

    await this.videos.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        thumbnail_key: thumbnailKey,
        duration_seconds: probe.durationSeconds,
        width: probe.width,
        height: probe.height,
        video_codec: probe.videoCodec,
        audio_codec: probe.audioCodec,
        container_format: probe.containerFormat,
        bitrate: probe.bitrate,
      },
    );
  }

  // Returns the error to throw: invalid media is non-retriable, anything else
  // is retried by BullMQ and only marked failed on the last attempt.
  private async handleFailure(
    video: Video,
    job: Job<ProcessVideoJobData>,
    error: unknown,
  ): Promise<Error> {
    const message = error instanceof Error ? error.message : String(error);

    if (
      error instanceof MediaProbeError ||
      error instanceof UnsupportedMediaError
    ) {
      await this.markFailed(video, VIDEO_FAILURE_REASONS.UNSUPPORTED_MEDIA);
      return new UnrecoverableError(message);
    }

    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade + 1 >= attempts) {
      await this.markFailed(video, VIDEO_FAILURE_REASONS.PROCESSING_FAILED);
    } else {
      this.logger.warn(
        `Attempt ${job.attemptsMade + 1}/${attempts} for video ${video.id} failed: ${message}`,
      );
    }
    return error instanceof Error ? error : new Error(message);
  }

  private async markFailed(video: Video, reason: string): Promise<void> {
    await this.videos.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
  }
}
