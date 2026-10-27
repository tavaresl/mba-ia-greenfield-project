import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import {
  SignedPartsResponseDto,
  UploadedPartsResponseDto,
} from './dto/upload-parts-response.dto';
import { VideosService } from './videos.service';

// The auth rate limit (APP_GUARD in AuthModule) is application-wide; video
// endpoints are polled/called in bursts and are exempt from it.
@SkipThrottle()
@ApiTags('videos')
@ApiBearerAuth()
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Pre-register a video and start its upload',
    description:
      'Creates the video as a draft in the caller channel and opens the S3 multipart upload. The client uploads the parts directly to storage.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created; part plan for the direct upload',
    type: CreateVideoResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVideoDto,
  ): Promise<CreateVideoResponseDto> {
    return this.videosService.createDraft(user.sub, dto);
  }

  @Post(':publicId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns one presigned URL per requested part number; PUT the part bytes straight to storage and keep each ETag.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    type: SignedPartsResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed or part number out of range',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async signParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: SignUploadPartsDto,
  ): Promise<SignedPartsResponseDto> {
    return this.videosService.signUploadParts(
      user.sub,
      publicId,
      dto.part_numbers,
    );
  }

  @Get(':publicId/upload/parts')
  @ApiOperation({
    summary: 'List the parts already uploaded',
    description: 'Used to resume an interrupted upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Uploaded parts in ascending order',
    type: UploadedPartsResponseDto,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async listParts(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<UploadedPartsResponseDto> {
    return this.videosService.listUploadedParts(user.sub, publicId);
  }

  @Post(':publicId/upload/complete')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Complete the upload and start processing',
    description:
      'Closes the multipart upload, verifies the assembled size, moves the video to processing and enqueues its processing job.',
  })
  @ApiResponse({
    status: 202,
    description: 'Upload completed; processing queued',
    type: CompleteUploadResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 422,
    description: 'Invalid parts, or the assembled file exceeds the size limit',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    return this.videosService.completeUpload(user.sub, publicId, dto.parts);
  }

  @Delete(':publicId/upload')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Cancel an open upload',
    description:
      'Aborts the multipart upload in storage and deletes the draft video.',
  })
  @ApiResponse({ status: 204, description: 'Upload cancelled' })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (or not owned by the caller)',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not accepting uploads',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async cancelUpload(
    @CurrentUser() user: JwtPayload,
    @Param('publicId') publicId: string,
  ): Promise<void> {
    return this.videosService.cancelUpload(user.sub, publicId);
  }
}
