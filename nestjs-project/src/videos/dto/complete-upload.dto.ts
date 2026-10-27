import { ApiProperty } from '@nestjs/swagger';
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
  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_MULTIPART_PARTS })
  @IsInt()
  @Min(1)
  @Max(MAX_MULTIPART_PARTS)
  part_number: number;

  @ApiProperty({
    example: '"9b2cf535f27731c974343645a3985328"',
    description: 'ETag returned by storage for the uploaded part',
  })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({
    type: [CompletedPartDto],
    minItems: 1,
    maxItems: MAX_PARTS_PER_COMPLETION,
    description: 'Every uploaded part with its ETag, in any order',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_COMPLETION)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
