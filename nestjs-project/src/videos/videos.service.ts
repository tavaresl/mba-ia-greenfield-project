import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_FILE_EXTENSIONS,
} from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video) private readonly videos: Repository<Video>,
    @InjectRepository(Channel) private readonly channels: Repository<Channel>,
    private readonly storage: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async createDraft(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    const channel = await this.channels.findOneByOrFail({ user_id: userId });
    const id = randomUUID();
    const extension = VIDEO_FILE_EXTENSIONS[dto.mime_type];
    const storageKey = `videos/${id}/original.${extension}`;

    const draft = await this.insertDraft({
      id,
      channel_id: channel.id,
      title: dto.title,
      original_file_name: dto.file_name,
      mime_type: dto.mime_type,
      declared_size: dto.file_size,
      storage_key: storageKey,
    });

    try {
      const uploadId = await this.storage.createMultipartUpload(
        storageKey,
        dto.mime_type,
      );
      await this.videos.update({ id }, { upload_id: uploadId });
    } catch (error) {
      await this.videos.delete({ id });
      throw error;
    }

    const partSize = this.config.uploadPartSizeBytes;
    return {
      id: draft.public_id,
      title: draft.title,
      status: draft.status,
      part_size: partSize,
      part_count: Math.ceil(dto.file_size / partSize),
    };
  }

  // The unique index on public_id is the real guarantee; retry on the rare clash.
  private async insertDraft(fields: Partial<Video>): Promise<Video> {
    for (let attempt = 1; attempt <= PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.videos.save(
          this.videos.create({
            ...fields,
            public_id: generatePublicId(),
            status: VideoStatus.DRAFT,
          }),
        );
      } catch (error) {
        if (!isPgUniqueViolationOnColumn(error, PUBLIC_ID_COLUMN)) throw error;
      }
    }
    throw new Error(
      `Could not generate a unique public id after ${PUBLIC_ID_MAX_ATTEMPTS} attempts`,
    );
  }
}
