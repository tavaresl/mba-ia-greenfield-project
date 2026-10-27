import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MAX_VIDEO_FILE_SIZE_BYTES,
  VIDEO_FILE_NAME_MAX_LENGTH,
  VIDEO_MIME_TYPES,
  VIDEO_TITLE_MAX_LENGTH,
  type VideoMimeType,
} from '../videos.constants';

export class CreateVideoDto {
  @ApiProperty({
    example: 'My first video',
    maxLength: VIDEO_TITLE_MAX_LENGTH,
    description: 'Trimmed; editable later',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  title: string;

  @ApiProperty({
    example: 'clip.mp4',
    maxLength: VIDEO_FILE_NAME_MAX_LENGTH,
    description: 'Original file name; used as the download name',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(VIDEO_FILE_NAME_MAX_LENGTH)
  file_name: string;

  @ApiProperty({
    example: 11534336,
    minimum: 1,
    maximum: MAX_VIDEO_FILE_SIZE_BYTES,
    description: 'File size in bytes (at most 10 GiB)',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_FILE_SIZE_BYTES)
  file_size: number;

  @ApiProperty({ enum: VIDEO_MIME_TYPES, example: 'video/mp4' })
  @IsIn(VIDEO_MIME_TYPES)
  mime_type: VideoMimeType;
}
