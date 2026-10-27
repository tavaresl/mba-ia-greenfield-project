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
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(VIDEO_TITLE_MAX_LENGTH)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(VIDEO_FILE_NAME_MAX_LENGTH)
  file_name: string;

  @IsInt()
  @Min(1)
  @Max(MAX_VIDEO_FILE_SIZE_BYTES)
  file_size: number;

  @IsIn(VIDEO_MIME_TYPES)
  mime_type: VideoMimeType;
}
