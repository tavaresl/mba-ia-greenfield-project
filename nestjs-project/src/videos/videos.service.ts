import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  InvalidPartNumbersException,
  InvalidUploadPartsException,
  UploadSizeExceededException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { MultipartCompletionError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import type { CompletedPartDto } from './dto/complete-upload.dto';
import type { CreateVideoResponseDto } from './dto/create-video-response.dto';
import type { VideoResponseDto } from './dto/video-response.dto';
import type {
  SignedPartsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  PUBLIC_ID_MAX_ATTEMPTS,
  VIDEO_FAILURE_REASONS,
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
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
    private readonly processing: VideoProcessingProducer,
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

  async signUploadParts(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignedPartsResponseDto> {
    const video = this.requireOpenUpload(
      await this.findOwnedOrFail(userId, publicId),
    );
    const partCount = this.partCountOf(video);
    if (partNumbers.some((number) => number > partCount)) {
      throw new InvalidPartNumbersException();
    }

    const expiresIn = this.storageSettings.uploadUrlTtlSeconds;
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storage.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expires_in: expiresIn };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    const video = this.requireOpenUpload(
      await this.findOwnedOrFail(userId, publicId),
    );
    const parts = await this.storage.listParts(
      video.storage_key,
      video.upload_id!,
    );
    return {
      parts: parts.map(({ partNumber, etag, size }) => ({
        part_number: partNumber,
        etag,
        size,
      })),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    parts: CompletedPartDto[],
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedOrFail(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotUploadableException();
    }

    // upload_id is cleared once the multipart upload is assembled, so a retry
    // (e.g. after a failed enqueue) skips straight to the size check.
    if (video.upload_id) {
      try {
        await this.storage.completeMultipartUpload(
          video.storage_key,
          video.upload_id,
          parts.map(({ part_number, etag }) => ({
            partNumber: part_number,
            etag,
          })),
        );
      } catch (error) {
        if (error instanceof MultipartCompletionError) {
          throw new InvalidUploadPartsException();
        }
        throw error;
      }
      await this.videos.update({ id: video.id }, { upload_id: null });
    }

    const { contentLength } = await this.storage.headObject(video.storage_key);
    if (contentLength > this.config.maxUploadBytes) {
      await this.storage.deleteObject(video.storage_key);
      await this.videos.update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          failure_reason: VIDEO_FAILURE_REASONS.UPLOAD_SIZE_EXCEEDED,
        },
      );
      throw new UploadSizeExceededException();
    }

    // Conditional transition: only one concurrent request may move draft -> processing.
    const moved = await this.videos.update(
      { id: video.id, status: VideoStatus.DRAFT },
      { status: VideoStatus.PROCESSING, file_size: contentLength },
    );
    if (!moved.affected) {
      throw new VideoNotUploadableException();
    }

    try {
      await this.processing.enqueue(video.id);
    } catch (error) {
      await this.videos.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
      throw error;
    }

    return { id: video.public_id, status: VideoStatus.PROCESSING };
  }

  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedOrFail(userId, publicId);
    return this.toResponse(video);
  }

  async getStreamUrl(userId: string, publicId: string): Promise<string> {
    const video = this.requireReady(
      await this.findOwnedOrFail(userId, publicId),
    );
    return this.presignOriginal(video);
  }

  async getDownloadUrl(userId: string, publicId: string): Promise<string> {
    const video = this.requireReady(
      await this.findOwnedOrFail(userId, publicId),
    );
    return this.presignOriginal(video, video.original_file_name);
  }

  async cancelUpload(userId: string, publicId: string): Promise<void> {
    const video = await this.findOwnedOrFail(userId, publicId);
    if (video.status !== VideoStatus.DRAFT) {
      throw new VideoNotUploadableException();
    }
    if (video.upload_id) {
      await this.storage.abortMultipartUpload(
        video.storage_key,
        video.upload_id,
      );
    }
    await this.videos.delete({ id: video.id });
  }

  // Non-owners and unknown ids look the same, so other channels' videos are not revealed.
  async findOwnedOrFail(userId: string, publicId: string): Promise<Video> {
    const video = await this.videos.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private requireReady(video: Video): Video {
    if (video.status !== VideoStatus.READY) throw new VideoNotReadyException();
    return video;
  }

  // Signed for the client-reachable endpoint: storage serves Range/206 itself.
  private presignOriginal(
    video: Video,
    downloadFileName?: string,
  ): Promise<string> {
    return this.storage.presignGetObject(video.storage_key, {
      signer: 'public',
      expiresIn: this.storageSettings.downloadUrlTtlSeconds,
      downloadFileName,
    });
  }

  private async toResponse(video: Video): Promise<VideoResponseDto> {
    const thumbnailUrl = video.thumbnail_key
      ? await this.storage.presignGetObject(video.thumbnail_key, {
          signer: 'public',
          expiresIn: this.storageSettings.downloadUrlTtlSeconds,
        })
      : null;

    return {
      id: video.public_id,
      title: video.title,
      status: video.status,
      failure_reason: video.failure_reason,
      original_file_name: video.original_file_name,
      mime_type: video.mime_type,
      file_size: video.file_size,
      duration_seconds: video.duration_seconds,
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      container_format: video.container_format,
      bitrate: video.bitrate,
      thumbnail_url: thumbnailUrl,
      created_at: video.created_at.toISOString(),
      updated_at: video.updated_at.toISOString(),
    };
  }

  private requireOpenUpload(video: Video): Video {
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotUploadableException();
    }
    return video;
  }

  private partCountOf(video: Video): number {
    return Math.ceil(video.declared_size / this.config.uploadPartSizeBytes);
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
