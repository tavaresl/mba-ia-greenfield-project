import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../videos/video-processing.constants';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with the shared config, database and queue wiring', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module.get(DataSource)).toBeDefined();
    expect(module.get(ConfigService).get('queue.prefix')).toBe('test');
    expect(module.get(getQueueToken(VIDEO_PROCESSING_QUEUE))).toBeDefined();
    await module.close();
  }, 30000);
});
