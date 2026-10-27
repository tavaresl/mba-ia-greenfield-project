// ffprobe could not read the input as a video (unreadable, no video stream, ...).
export class MediaProbeError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = '',
  ) {
    super(stderr ? `${message}: ${stderr}` : message);
    this.name = 'MediaProbeError';
  }
}

// An ffmpeg/ffprobe run failed for a reason unrelated to the media itself
// (timeout, missing binary, non-zero exit while extracting a frame, ...).
export class MediaProcessingError extends Error {
  constructor(
    message: string,
    public readonly stderr: string = '',
    public readonly exitCode: number | null = null,
  ) {
    super(stderr ? `${message}: ${stderr}` : message);
    this.name = 'MediaProcessingError';
  }
}
