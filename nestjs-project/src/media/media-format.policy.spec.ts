import { isSupportedMedia } from './media-format.policy';

describe('isSupportedMedia', () => {
  it.each([
    ['h264', 'aac', 'video/mp4'],
    ['h264', null, 'video/mp4'],
    ['vp9', 'opus', 'video/webm'],
    ['vp8', 'vorbis', 'video/webm'],
    ['av1', 'opus', 'video/webm'],
    ['vp9', null, 'video/webm'],
  ])('should accept %s + %s as %s', (videoCodec, audioCodec, mimeType) => {
    expect(isSupportedMedia({ videoCodec, audioCodec }, mimeType)).toBe(true);
  });

  it.each([
    ['mpeg4', 'aac', 'video/mp4', 'non-H.264 MP4 video'],
    ['hevc', 'aac', 'video/mp4', 'HEVC MP4 video'],
    ['h264', 'mp3', 'video/mp4', 'unsupported MP4 audio'],
    ['h264', 'opus', 'video/webm', 'H.264 inside WebM'],
    ['vp9', 'aac', 'video/webm', 'unsupported WebM audio'],
    ['h264', 'aac', 'video/quicktime', 'unknown MIME type'],
  ])('should reject %s + %s as %s (%s)', (videoCodec, audioCodec, mimeType) => {
    expect(isSupportedMedia({ videoCodec, audioCodec }, mimeType)).toBe(false);
  });
});
