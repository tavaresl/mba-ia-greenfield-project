export const VIDEO_MIME_TYPES = ['video/mp4', 'video/webm'] as const;
export type VideoMimeType = (typeof VIDEO_MIME_TYPES)[number];

export const VIDEO_FILE_EXTENSIONS: Record<VideoMimeType, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

// Hard product limit (TD-11); VIDEO_MAX_UPLOAD_BYTES can only lower it.
export const MAX_VIDEO_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;

export const VIDEO_TITLE_MAX_LENGTH = 100;
export const VIDEO_FILE_NAME_MAX_LENGTH = 255;
export const PUBLIC_ID_MAX_ATTEMPTS = 5;
export const MAX_PART_NUMBERS_PER_REQUEST = 100;
// S3 allows at most 10,000 parts per multipart upload.
export const MAX_MULTIPART_PARTS = 10000;
export const MAX_PARTS_PER_COMPLETION = MAX_MULTIPART_PARTS;

export const VIDEO_FAILURE_REASONS = {
  UPLOAD_SIZE_EXCEEDED: 'UPLOAD_SIZE_EXCEEDED',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  PROCESSING_FAILED: 'PROCESSING_FAILED',
} as const;

export const THUMBNAIL_FILE_NAME = 'thumbnail.jpg';
export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';
export const thumbnailKeyFor = (videoId: string): string =>
  `videos/${videoId}/${THUMBNAIL_FILE_NAME}`;
