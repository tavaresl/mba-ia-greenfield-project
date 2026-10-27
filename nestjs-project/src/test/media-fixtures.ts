import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface MediaFixtures {
  dir: string;
  /** 3 s, 640x360, H.264 + AAC (MP4). */
  h264Mp4: string;
  /** 3 s, 640x360, VP9 + Opus (WebM). */
  vp9Webm: string;
  /** 3 s, 640x360, MPEG-4 part 2 + AAC (MP4) — not web-playable. */
  mpeg4Mp4: string;
  /** 3 s, 640x360, H.264 without an audio stream (MP4). */
  silentMp4: string;
  /** Plain text, not media. */
  textFile: string;
  cleanup: () => Promise<void>;
}

const SOURCES = [
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=3:size=640x360:rate=25',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=3',
];

async function ffmpeg(args: string[]): Promise<void> {
  await execFileAsync('ffmpeg', ['-v', 'error', '-y', ...args]);
}

// Generates tiny sample files with the real ffmpeg binary (video-worker image).
export async function createMediaFixtures(): Promise<MediaFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'streamtube-media-'));
  const path = (name: string) => join(dir, name);

  const h264Mp4 = path('h264-aac.mp4');
  const vp9Webm = path('vp9-opus.webm');
  const mpeg4Mp4 = path('mpeg4-aac.mp4');
  const silentMp4 = path('h264-silent.mp4');
  const textFile = path('not-media.txt');

  await Promise.all([
    ffmpeg([
      ...SOURCES,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      h264Mp4,
    ]),
    ffmpeg([
      ...SOURCES,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-c:a',
      'libopus',
      '-shortest',
      vp9Webm,
    ]),
    ffmpeg([...SOURCES, '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', mpeg4Mp4]),
    ffmpeg([
      ...SOURCES.slice(0, 4),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      silentMp4,
    ]),
    writeFile(textFile, 'this is not a video'),
  ]);

  return {
    dir,
    h264Mp4,
    vp9Webm,
    mpeg4Mp4,
    silentMp4,
    textFile,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
