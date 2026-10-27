import { createServer, type Server, type Socket } from 'net';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import videosConfig from '../config/videos.config';
import {
  createMediaFixtures,
  type MediaFixtures,
} from '../test/media-fixtures';
import { FfmpegService } from './ffmpeg.service';
import { MediaProbeError, MediaProcessingError } from './media.errors';
import { MediaModule } from './media.module';

// Resolves with the rejection reason (or fails if the promise resolves).
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the promise to reject');
}

// Needs the real ffmpeg/ffprobe binaries: runs in the video-worker container.
describe('FfmpegService (integration)', () => {
  let module: TestingModule;
  let ffmpeg: FfmpegService;
  let fixtures: MediaFixtures;

  beforeAll(async () => {
    fixtures = await createMediaFixtures();
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [videosConfig] }),
        MediaModule,
      ],
    }).compile();
    ffmpeg = module.get(FfmpegService);
  }, 60000);

  afterAll(async () => {
    await fixtures.cleanup();
    await module.close();
  });

  describe('probe', () => {
    it('should extract metadata from an H.264/AAC MP4', async () => {
      const probe = await ffmpeg.probe(fixtures.h264Mp4);

      expect(probe.durationSeconds).toBeCloseTo(3, 0);
      expect(probe).toMatchObject({
        width: 640,
        height: 360,
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
      expect(probe.containerFormat).toContain('mp4');
      expect(probe.bitrate).toBeGreaterThan(0);
    });

    it('should extract metadata from a VP9/Opus WebM', async () => {
      const probe = await ffmpeg.probe(fixtures.vp9Webm);

      expect(probe).toMatchObject({
        width: 640,
        height: 360,
        videoCodec: 'vp9',
        audioCodec: 'opus',
      });
      expect(probe.containerFormat).toContain('webm');
    });

    it('should report a null audio codec when the file has no audio', async () => {
      const probe = await ffmpeg.probe(fixtures.silentMp4);

      expect(probe.videoCodec).toBe('h264');
      expect(probe.audioCodec).toBeNull();
    });

    it('should report the codec of an unsupported file instead of failing', async () => {
      const probe = await ffmpeg.probe(fixtures.mpeg4Mp4);

      expect(probe.videoCodec).toBe('mpeg4');
    });

    it('should raise MediaProbeError with the ffprobe output for a non-media file', async () => {
      const error = await rejectionOf(ffmpeg.probe(fixtures.textFile));

      expect(error).toBeInstanceOf(MediaProbeError);
      expect((error as MediaProbeError).stderr).not.toBe('');
    });

    it('should raise MediaProbeError for a path that does not exist', async () => {
      await expect(
        ffmpeg.probe(`${fixtures.dir}/missing.mp4`),
      ).rejects.toBeInstanceOf(MediaProbeError);
    });
  });

  describe('extractThumbnail', () => {
    it('should return a JPEG frame', async () => {
      const jpeg = await ffmpeg.extractThumbnail(fixtures.h264Mp4, 1);

      expect(jpeg.length).toBeGreaterThan(0);
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    });

    it('should raise MediaProcessingError when no frame can be produced', async () => {
      await expect(
        ffmpeg.extractThumbnail(fixtures.textFile, 1),
      ).rejects.toBeInstanceOf(MediaProcessingError);
    });
  });

  describe('timeout', () => {
    let silentServer: Server;
    let port: number;
    const sockets = new Set<Socket>();

    beforeAll(async () => {
      // Accepts connections and never answers, so ffprobe blocks on the read.
      silentServer = createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
      });
      await new Promise<void>((resolve) =>
        silentServer.listen(0, '127.0.0.1', resolve),
      );
      port = (silentServer.address() as { port: number }).port;
    });

    afterAll(async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => silentServer.close(resolve));
    });

    it('should kill a run that exceeds the timeout and raise MediaProcessingError', async () => {
      const startedAt = Date.now();

      const error = await rejectionOf(
        ffmpeg.probe(`http://127.0.0.1:${port}/video.mp4`, { timeoutMs: 700 }),
      );

      expect(error).toBeInstanceOf(MediaProcessingError);
      expect((error as Error).message).toContain('timed out');
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });
  });
});
