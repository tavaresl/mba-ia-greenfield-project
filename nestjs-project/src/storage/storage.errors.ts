export class MultipartCompletionError extends Error {
  constructor(
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Multipart upload could not be completed: ${reason}`, options);
    this.name = 'MultipartCompletionError';
  }
}
