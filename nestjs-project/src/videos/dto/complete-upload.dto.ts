import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  MAX_MULTIPART_PARTS,
  MAX_PARTS_PER_COMPLETION,
} from '../videos.constants';

export class CompletedPartDto {
  @IsInt()
  @Min(1)
  @Max(MAX_MULTIPART_PARTS)
  part_number: number;

  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_COMPLETION)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
