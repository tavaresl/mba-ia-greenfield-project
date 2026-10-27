import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmAsyncOptions } from '../database/typeorm.options';
import { bullAsyncOptions } from '../queue/bull.options';
import { VIDEO_PROCESSING_QUEUE } from '../videos/video-processing.constants';

// Root module of the video worker process: no HTTP layer, only the shared
// config/database/queue wiring. The processor is added in a later step.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    BullModule.forRootAsync(bullAsyncOptions),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
})
export class WorkerModule {}
