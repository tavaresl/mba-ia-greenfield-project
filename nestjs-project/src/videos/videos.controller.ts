import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
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
import { CreateVideoResponseDto } from './dto/create-video-response.dto';
import { CreateVideoDto } from './dto/create-video.dto';
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
}
