import type { VideoMimeType } from '../videos/videos.constants';
import type { MediaProbe } from './media.types';

interface FormatRule {
  videoCodecs: readonly string[];
  audioCodecs: readonly string[];
}

// Web-playable combinations accepted for streaming the original file (TD-07).
const FORMAT_RULES: Record<VideoMimeType, FormatRule> = {
  'video/mp4': { videoCodecs: ['h264'], audioCodecs: ['aac'] },
  'video/webm': {
    videoCodecs: ['vp8', 'vp9', 'av1'],
    audioCodecs: ['vorbis', 'opus'],
  },
};

// The audio stream is optional; when present its codec must be accepted too.
export function isSupportedMedia(
  probe: Pick<MediaProbe, 'videoCodec' | 'audioCodec'>,
  mimeType: string,
): boolean {
  const rule = FORMAT_RULES[mimeType as VideoMimeType];
  if (!rule) return false;

  return (
    rule.videoCodecs.includes(probe.videoCodec) &&
    (probe.audioCodec === null || rule.audioCodecs.includes(probe.audioCodec))
  );
}
