import { spawn } from 'child_process';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import videosConfig from '../config/videos.config';
import { MediaProbeError, MediaProcessingError } from './media.errors';
import type { MediaProbe } from './media.types';

interface RunOptions {
  timeoutMs?: number;
}

interface RunResult {
  stdout: Buffer;
  stderr: string;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

const STDERR_LIMIT = 4096;

@Injectable()
export class FfmpegService {
  constructor(
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  // `input` is a local path or an HTTP(S) URL (e.g. a presigned GET).
  async probe(input: string, options: RunOptions = {}): Promise<MediaProbe> {
    let result: RunResult;
    try {
      result = await this.run(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          input,
        ],
        options,
      );
    } catch (error) {
      // A failing ffprobe exit means the input is not readable media.
      if (error instanceof MediaProcessingError && error.exitCode !== null) {
        throw new MediaProbeError(
          'ffprobe could not read the input',
          error.stderr,
        );
      }
      throw error;
    }

    let parsed: FfprobeOutput;
    try {
      parsed = JSON.parse(result.stdout.toString('utf8')) as FfprobeOutput;
    } catch {
      throw new MediaProbeError('ffprobe returned unparsable output');
    }
    return this.toMediaProbe(parsed);
  }

  async extractThumbnail(
    input: string,
    atSeconds: number,
    options: RunOptions = {},
  ): Promise<Buffer> {
    const { stdout } = await this.run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(atSeconds),
        '-i',
        input,
        '-frames:v',
        '1',
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      options,
    );
    if (stdout.length === 0) {
      throw new MediaProcessingError('ffmpeg produced no frame');
    }
    return stdout;
  }

  private toMediaProbe(output: FfprobeOutput): MediaProbe {
    const streams = output.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const duration = Number.parseFloat(output.format?.duration ?? '');

    if (!video?.codec_name || !video.width || !video.height) {
      throw new MediaProbeError('input has no video stream');
    }
    if (!Number.isFinite(duration)) {
      throw new MediaProbeError('input has no duration');
    }

    const bitrate = Number.parseInt(output.format?.bit_rate ?? '', 10);
    return {
      durationSeconds: duration,
      width: video.width,
      height: video.height,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name ?? null,
      containerFormat: output.format?.format_name ?? 'unknown',
      bitrate: Number.isFinite(bitrate) ? bitrate : null,
    };
  }

  private run(
    command: 'ffprobe' | 'ffmpeg',
    args: string[],
    { timeoutMs = this.config.mediaTimeoutMs }: RunOptions,
  ): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(timeoutMs),
        killSignal: 'SIGKILL',
      });
      const chunks: Buffer[] = [];
      let stderr = '';

      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_LIMIT);
      });
      child.on('error', (error: Error) => {
        reject(
          error.name === 'AbortError'
            ? new MediaProcessingError(
                `${command} timed out after ${timeoutMs} ms`,
                stderr.trim(),
              )
            : new MediaProcessingError(
                `${command} could not be started: ${error.message}`,
              ),
        );
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve({ stdout: Buffer.concat(chunks), stderr: stderr.trim() });
        } else if (code !== null) {
          reject(
            new MediaProcessingError(
              `${command} exited with code ${code}`,
              stderr.trim(),
              code,
            ),
          );
        }
      });
    });
  }
}
