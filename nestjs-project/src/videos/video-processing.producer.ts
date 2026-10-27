import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
  type ProcessVideoJobData,
} from './video-processing.constants';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue<ProcessVideoJobData>,
  ) {}

  // jobId = videoId: BullMQ ignores a second add while the first job exists.
  async enqueue(videoId: string): Promise<void> {
    await this.queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
    );
  }
}
