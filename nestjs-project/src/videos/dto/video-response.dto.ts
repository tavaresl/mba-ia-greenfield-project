import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({ example: 'dBjftJeZ4CV', description: 'Public video id' })
  id: string;

  @ApiProperty({ example: 'My first video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.READY })
  status: VideoStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Set only when status is failed',
  })
  failure_reason: string | null;

  @ApiProperty({ example: 'clip.mp4' })
  original_file_name: string;

  @ApiProperty({ example: 'video/mp4' })
  mime_type: string;

  @ApiProperty({ type: Number, nullable: true, example: 51293 })
  file_size: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3.04 })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 640 })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 360 })
  height: number | null;

  @ApiProperty({ type: String, nullable: true, example: 'h264' })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'aac' })
  audio_codec: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'mov,mp4,m4a,3gp,3g2,mj2',
  })
  container_format: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 136781 })
  bitrate: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Presigned URL of the thumbnail; null until the video is ready',
  })
  thumbnail_url: string | null;

  @ApiProperty({ example: '2026-10-27T11:20:29.000Z' })
  created_at: string;

  @ApiProperty({ example: '2026-10-27T11:20:31.000Z' })
  updated_at: string;
}
