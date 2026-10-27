import { ApiProperty } from '@nestjs/swagger';

export class SignedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({
    description: 'Presigned URL; PUT the raw part bytes to it',
    example: 'http://localhost:9000/streamtube/videos/…?X-Amz-Signature=…',
  })
  url: string;
}

export class SignedPartsResponseDto {
  @ApiProperty({ type: [SignedPartDto] })
  parts: SignedPartDto[];

  @ApiProperty({ example: 3600, description: 'URL lifetime in seconds' })
  expires_in: number;
}

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9b2cf535f27731c974343645a3985328"' })
  etag: string;

  @ApiProperty({ example: 104857600, description: 'Part size in bytes' })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
