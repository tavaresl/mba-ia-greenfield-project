export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
export const S3_SIGNING_CLIENT = Symbol('S3_SIGNING_CLIENT');

// S3 error names that mean "CompleteMultipartUpload rejected these parts".
export const MULTIPART_COMPLETION_ERROR_NAMES = [
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
  'NoSuchUpload',
] as const;
