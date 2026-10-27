import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'dBjftJeZ4CV', description: 'Public video id' })
  id: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.PROCESSING })
  status: VideoStatus;
}
