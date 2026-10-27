import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmAsyncOptions } from '../database/typeorm.options';
import { MediaModule } from '../media/media.module';
import { bullAsyncOptions } from '../queue/bull.options';
import { StorageModule } from '../storage/storage.module';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/video-processing.constants';
import { VideoProcessor } from './video.processor';

// Root module of the video worker process: no HTTP layer. The processor lives
// here and nowhere else, so the API never consumes processing jobs.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmAsyncOptions),
    BullModule.forRootAsync(bullAsyncOptions),
    // Video -> Channel -> User are related entities: TypeORM needs all of them
    // in the connection metadata even though only Video is queried.
    TypeOrmModule.forFeature([Video, Channel, User]),
    StorageModule,
    MediaModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
