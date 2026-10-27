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
