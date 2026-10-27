import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  InvalidPartNumbersException,
  VideoNotFoundException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
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
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const storage = {
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };

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

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: videosConfig.KEY,
          useValue: { maxUploadBytes: TEN_GIB, uploadPartSizeBytes: 104857600 },
        },
        { provide: storageConfig.KEY, useValue: { uploadUrlTtlSeconds: 900 } },
        { provide: getRepositoryToken(Video), useValue: videos },
        { provide: getRepositoryToken(Channel), useValue: {} },
        { provide: StorageService, useValue: storage },
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
});
