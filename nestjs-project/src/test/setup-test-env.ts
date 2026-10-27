// Runs after `dotenv/config` (see jest `setupFiles`). Tests execute inside the
// Compose network, so presigned URLs must point at the in-network endpoint;
// queue jobs use their own prefix so the running worker never consumes them;
// small limits make multi-part and size-limit paths testable with a few MiB.
process.env.S3_PUBLIC_ENDPOINT = process.env.S3_ENDPOINT || 'http://minio:9000';
process.env.QUEUE_PREFIX = 'test';
process.env.VIDEO_UPLOAD_PART_SIZE_BYTES = '5242880';
process.env.VIDEO_MAX_UPLOAD_BYTES = '12582912';
