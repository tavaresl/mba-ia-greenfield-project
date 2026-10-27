import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let storage: StorageService;
  let userId: string;
  let channelId: string;
  const uploadsToAbort: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video, Channel]),
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();
    service = module.get(VideosService);
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: 'owner@example.com',
      password: 'hashed',
    });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'owner',
      user_id: user.id,
    });
    userId = user.id;
    channelId = channel.id;
  });

  afterEach(async () => {
    for (const { key, uploadId } of uploadsToAbort.splice(0)) {
      await storage.abortMultipartUpload(key, uploadId);
    }
  });

  afterAll(async () => {
    await module.close();
  });

  it('should persist a draft in the caller channel with an open multipart upload', async () => {
    const result = await service.createDraft(userId, {
      title: 'My video',
      file_name: 'clip.webm',
      file_size: 11534336,
      mime_type: 'video/webm',
    });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.id });
    uploadsToAbort.push({ key: row.storage_key, uploadId: row.upload_id! });

    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.channel_id).toBe(channelId);
    expect(row.title).toBe('My video');
    expect(row.original_file_name).toBe('clip.webm');
    expect(row.mime_type).toBe('video/webm');
    expect(row.declared_size).toBe(11534336);
    expect(row.upload_id).toEqual(expect.any(String));
    expect(row.storage_key).toBe(`videos/${row.id}/original.webm`);
    expect(result).toMatchObject({
      title: 'My video',
      status: 'draft',
      part_size: 5242880,
      part_count: 3,
    });
  });

  it('should leave the open multipart upload listable in storage', async () => {
    const result = await service.createDraft(userId, {
      title: 'Another',
      file_name: 'clip.mp4',
      file_size: 1024,
      mime_type: 'video/mp4',
    });
    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: result.id });
    uploadsToAbort.push({ key: row.storage_key, uploadId: row.upload_id! });

    await expect(
      storage.listParts(row.storage_key, row.upload_id!),
    ).resolves.toEqual([]);
  });
});
