import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../entities/video.entity';

export class CreateVideoResponseDto {
  @ApiProperty({ example: 'dBjftJeZ4CV', description: 'Public video id' })
  id: string;

  @ApiProperty({ example: 'My first video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({
    example: 104857600,
    description: 'Bytes per part; every part except the last has this size',
  })
  part_size: number;

  @ApiProperty({ example: 3 })
  part_count: number;
}
