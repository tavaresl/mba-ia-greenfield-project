import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidPartNumbersException,
  InvalidUploadPartsException,
  UploadSizeExceededException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { MultipartCompletionError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosService } from './videos.service';

const TEN_GIB = 10 * 1024 * 1024 * 1024;

function publicIdClash(): QueryFailedError {
  return new QueryFailedError(
    'INSERT INTO videos',
    [],
    Object.assign(new Error('duplicate key'), {
      code: '23505',
      detail: 'Key (public_id)=(abcdefghijk) already exists.',
    }),
  );
}

describe('VideosService.createDraft', () => {
  const dto = {
    title: 'My video',
    file_name: 'clip.mp4',
    file_size: TEN_GIB,
    mime_type: 'video/mp4' as const,
  };

  let service: VideosService;
  const videos = {
    create: jest.fn((entity: Partial<Video>) => entity),
    save: jest.fn((entity: Partial<Video>) => Promise.resolve(entity)),
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const channels = {
    findOneByOrFail: jest.fn().mockResolvedValue({ id: 'channel-1' }),
  };
  const storage = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    videos.save.mockImplementation((entity: Partial<Video>) =>
      Promise.resolve(entity),
    );
    storage.createMultipartUpload.mockResolvedValue('upload-1');

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          // Production defaults, independent of the small limits set for tests.
          provide: videosConfig.KEY,
          useValue: {
            maxUploadBytes: TEN_GIB,
            uploadPartSizeBytes: 104857600,
          },
        },
        {
          provide: storageConfig.KEY,
          useValue: { uploadUrlTtlSeconds: 3600 },
        },
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: getRepositoryToken(Channel), useValue: channels },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: { enqueue: jest.fn() } },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  it('should compute 103 parts for 10 GiB at the default part size', async () => {
    const result = await service.createDraft('user-1', dto);

    expect(result.part_size).toBe(104857600);
    expect(result.part_count).toBe(103);
    expect(result.status).toBe('draft');
    expect(result.id).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });

  it('should retry the public id on a unique violation', async () => {
    videos.save
      .mockRejectedValueOnce(publicIdClash())
      .mockRejectedValueOnce(publicIdClash());

    const result = await service.createDraft('user-1', dto);

    expect(videos.save).toHaveBeenCalledTimes(3);
    expect(result.id).toBeDefined();
  });

  it('should give up after 5 attempts on repeated public id clashes', async () => {
    videos.save.mockRejectedValue(publicIdClash());

    await expect(service.createDraft('user-1', dto)).rejects.toThrow(
      /unique public id/,
    );
    expect(videos.save).toHaveBeenCalledTimes(5);
    expect(storage.createMultipartUpload).not.toHaveBeenCalled();
  });

  it('should not swallow unrelated database errors', async () => {
    videos.save.mockRejectedValue(new Error('connection lost'));

    await expect(service.createDraft('user-1', dto)).rejects.toThrow(
      'connection lost',
    );
    expect(videos.save).toHaveBeenCalledTimes(1);
  });

  it('should delete the draft row when the multipart upload cannot be created', async () => {
    storage.createMultipartUpload.mockRejectedValue(new Error('storage down'));

    await expect(service.createDraft('user-1', dto)).rejects.toThrow(
      'storage down',
    );
    expect(videos.delete).toHaveBeenCalledTimes(1);
    expect(videos.update).not.toHaveBeenCalled();
  });
});

describe('VideosService upload operations', () => {
  let service: VideosService;
  const videos = {
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    presignUploadPart: jest.fn(),
    presignGetObject: jest.fn(),
    listParts: jest.fn(),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const producer = { enqueue: jest.fn() };

  // 11 MiB declared at the default 100 MiB part size => 1 part.
  const draft = (overrides: Partial<Video> = {}): Video =>
    ({
      id: 'video-1',
      public_id: 'abcdefghijk',
      status: VideoStatus.DRAFT,
      upload_id: 'upload-1',
      storage_key: 'videos/video-1/original.mp4',
      declared_size: 250 * 1024 * 1024,
      ...overrides,
    }) as Video;

  beforeEach(async () => {
    jest.clearAllMocks();
    videos.findOne.mockResolvedValue(draft());
    storage.presignUploadPart.mockImplementation(
      (_key: string, _uploadId: string, partNumber: number) =>
        Promise.resolve(`https://storage/part-${partNumber}`),
    );
    storage.listParts.mockResolvedValue([]);
    videos.update.mockResolvedValue({ affected: 1 });
    storage.completeMultipartUpload.mockResolvedValue(undefined);
    storage.headObject.mockResolvedValue({ contentLength: 1024 });
    producer.enqueue.mockResolvedValue(undefined);
    storage.presignGetObject.mockImplementation((key: string) =>
      Promise.resolve(`https://storage/${key}`),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: videosConfig.KEY,
          useValue: { maxUploadBytes: TEN_GIB, uploadPartSizeBytes: 104857600 },
        },
        {
          provide: storageConfig.KEY,
          useValue: { uploadUrlTtlSeconds: 900, downloadUrlTtlSeconds: 14400 },
        },
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: getRepositoryToken(Channel), useValue: {} },
        { provide: StorageService, useValue: storage },
        { provide: VideoProcessingProducer, useValue: producer },
      ],
    }).compile();
    service = module.get(VideosService);
  });

  describe('ownership', () => {
    it('should throw VideoNotFoundException when the video is not the caller’s', async () => {
      videos.findOne.mockResolvedValue(null);

      await expect(
        service.signUploadParts('user-2', 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.listUploadedParts('user-2', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      await expect(
        service.cancelUpload('user-2', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videos.findOne).toHaveBeenCalledWith({
        where: { public_id: 'abcdefghijk', channel: { user_id: 'user-2' } },
      });
    });
  });

  describe('signUploadParts', () => {
    it('should presign each requested part with the configured TTL', async () => {
      const result = await service.signUploadParts(
        'user-1',
        'abcdefghijk',
        [1, 3],
      );

      expect(result).toEqual({
        parts: [
          { part_number: 1, url: 'https://storage/part-1' },
          { part_number: 3, url: 'https://storage/part-3' },
        ],
        expires_in: 900,
      });
      expect(storage.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        3,
        900,
      );
    });

    it.each([
      ['not draft', { status: VideoStatus.PROCESSING }],
      ['without an open upload', { upload_id: null }],
    ])('should reject a video %s', async (_label, overrides) => {
      videos.findOne.mockResolvedValue(draft(overrides));

      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', [1]),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });

    it('should reject a part number above part_count', async () => {
      // 250 MiB at 100 MiB per part => 3 parts.
      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', [3, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumbersException);
      expect(storage.presignUploadPart).not.toHaveBeenCalled();
    });
  });

  describe('listUploadedParts', () => {
    it('should map storage parts to the response shape', async () => {
      storage.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"abc"', size: 5 },
      ]);

      await expect(
        service.listUploadedParts('user-1', 'abcdefghijk'),
      ).resolves.toEqual({
        parts: [{ part_number: 1, etag: '"abc"', size: 5 }],
      });
    });

    it('should reject a video that is not draft', async () => {
      videos.findOne.mockResolvedValue(draft({ status: VideoStatus.READY }));

      await expect(
        service.listUploadedParts('user-1', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });
  });

  describe('cancelUpload', () => {
    it('should abort the multipart upload and delete the row', async () => {
      await service.cancelUpload('user-1', 'abcdefghijk');

      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
      );
      expect(videos.delete).toHaveBeenCalledWith({ id: 'video-1' });
    });

    it('should skip the abort when there is no open upload', async () => {
      videos.findOne.mockResolvedValue(draft({ upload_id: null }));

      await service.cancelUpload('user-1', 'abcdefghijk');

      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
      expect(videos.delete).toHaveBeenCalledTimes(1);
    });

    it('should reject a video that is not draft and keep the row', async () => {
      videos.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.cancelUpload('user-1', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
      expect(videos.delete).not.toHaveBeenCalled();
    });
  });

  describe('completeUpload', () => {
    const parts = [
      { part_number: 2, etag: '"b"' },
      { part_number: 1, etag: '"a"' },
    ];

    it('should assemble the upload, move to processing and enqueue the job', async () => {
      const result = await service.completeUpload(
        'user-1',
        'abcdefghijk',
        parts,
      );

      expect(result).toEqual({ id: 'abcdefghijk', status: 'processing' });
      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        'upload-1',
        [
          { partNumber: 2, etag: '"b"' },
          { partNumber: 1, etag: '"a"' },
        ],
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { upload_id: null },
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, file_size: 1024 },
      );
      expect(producer.enqueue).toHaveBeenCalledWith('video-1');
    });

    it('should translate a storage rejection into INVALID_UPLOAD_PARTS and stay draft', async () => {
      storage.completeMultipartUpload.mockRejectedValue(
        new MultipartCompletionError('InvalidPart'),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(videos.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should let unrelated storage errors through', async () => {
      storage.completeMultipartUpload.mockRejectedValue(new Error('boom'));

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toThrow('boom');
    });

    it('should delete an oversize object and mark the video failed', async () => {
      storage.headObject.mockResolvedValue({ contentLength: TEN_GIB + 1 });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(UploadSizeExceededException);
      expect(storage.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
      );
      expect(videos.update).toHaveBeenCalledWith(
        { id: 'video-1' },
        { status: VideoStatus.FAILED, failure_reason: 'UPLOAD_SIZE_EXCEEDED' },
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should skip assembling when the upload was already completed (retry)', async () => {
      videos.findOne.mockResolvedValue(draft({ upload_id: null }));

      await service.completeUpload('user-1', 'abcdefghijk', parts);

      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueue).toHaveBeenCalledTimes(1);
    });

    it('should revert to draft and rethrow when enqueueing fails', async () => {
      producer.enqueue.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toThrow('redis down');
      expect(videos.update).toHaveBeenLastCalledWith(
        { id: 'video-1', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
    });

    it('should not enqueue when a concurrent request already moved the video', async () => {
      videos.update.mockImplementation((where: { status?: VideoStatus }) =>
        Promise.resolve({ affected: where.status ? 0 : 1 }),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('should reject a video that is not draft', async () => {
      videos.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk', parts),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    });
  });

  describe('getOwnedVideo', () => {
    const stored = (overrides: Partial<Video> = {}) =>
      draft({
        title: 'My video',
        failure_reason: null,
        original_file_name: 'clip.mp4',
        mime_type: 'video/mp4',
        file_size: null,
        thumbnail_key: null,
        duration_seconds: null,
        width: null,
        height: null,
        video_codec: null,
        audio_codec: null,
        container_format: null,
        bitrate: null,
        created_at: new Date('2026-10-27T10:00:00.000Z'),
        updated_at: new Date('2026-10-27T10:05:00.000Z'),
        ...overrides,
      });

    it('should expose the public id, null metadata and a null thumbnail_url before processing', async () => {
      videos.findOne.mockResolvedValue(stored());

      const result = await service.getOwnedVideo('user-1', 'abcdefghijk');

      expect(result).toMatchObject({
        id: 'abcdefghijk',
        title: 'My video',
        status: 'draft',
        duration_seconds: null,
        width: null,
        thumbnail_url: null,
        created_at: '2026-10-27T10:00:00.000Z',
        updated_at: '2026-10-27T10:05:00.000Z',
      });
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('should presign the thumbnail with the public signer when it exists', async () => {
      videos.findOne.mockResolvedValue(
        stored({
          status: VideoStatus.READY,
          thumbnail_key: 'videos/video-1/thumbnail.jpg',
          width: 640,
        }),
      );

      const result = await service.getOwnedVideo('user-1', 'abcdefghijk');

      expect(result.thumbnail_url).toBe(
        'https://storage/videos/video-1/thumbnail.jpg',
      );
      expect(result.width).toBe(640);
      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        { signer: 'public', expiresIn: 14400 },
      );
    });
  });

  describe('getStreamUrl / getDownloadUrl', () => {
    const ready = (overrides: Partial<Video> = {}) =>
      draft({
        status: VideoStatus.READY,
        original_file_name: 'my "best" clip.mp4',
        ...overrides,
      });

    it('should presign the original for streaming without a download name', async () => {
      videos.findOne.mockResolvedValue(ready());

      const url = await service.getStreamUrl('user-1', 'abcdefghijk');

      expect(url).toBe('https://storage/videos/video-1/original.mp4');
      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        { signer: 'public', expiresIn: 14400, downloadFileName: undefined },
      );
    });

    it('should pass the original file name to the download URL', async () => {
      videos.findOne.mockResolvedValue(ready());

      await service.getDownloadUrl('user-1', 'abcdefghijk');

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original.mp4',
        expect.objectContaining({ downloadFileName: 'my "best" clip.mp4' }),
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'should reject a %s video',
      async (status) => {
        videos.findOne.mockResolvedValue(ready({ status }));

        await expect(
          service.getStreamUrl('user-1', 'abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        await expect(
          service.getDownloadUrl('user-1', 'abcdefghijk'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        expect(storage.presignGetObject).not.toHaveBeenCalled();
      },
    );

    it('should hide another user’s video', async () => {
      videos.findOne.mockResolvedValue(null);

      await expect(
        service.getStreamUrl('user-2', 'abcdefghijk'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
