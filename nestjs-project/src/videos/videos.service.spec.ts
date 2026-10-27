import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
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
    update: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const channels = {
    findOneByOrFail: jest.fn().mockResolvedValue({ id: 'channel-1' }),
  };
  const storage = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
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
