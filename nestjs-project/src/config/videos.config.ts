import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  maxUploadBytes: parseInt(
    process.env.VIDEO_MAX_UPLOAD_BYTES || '10737418240',
    10,
  ),
  uploadPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || '104857600',
    10,
  ),
  mediaTimeoutMs:
    parseInt(process.env.VIDEO_MEDIA_TIMEOUT_SECONDS || '300', 10) * 1000,
}));
