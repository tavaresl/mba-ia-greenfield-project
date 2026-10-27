export interface MediaProbe {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string | null;
  containerFormat: string;
  bitrate: number | null;
}
