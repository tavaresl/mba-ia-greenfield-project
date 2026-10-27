import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const suffix = randomUUID().slice(0, 8);
    const user = await userRepository.save(
      userRepository.create({
        email: `video_owner_${suffix}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Owner',
        nickname: `owner_${suffix}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    const id = randomUUID();
    return videoRepository.create({
      id,
      public_id: generatePublicId(),
      channel_id: channelId,
      title: 'My video',
      original_file_name: 'clip.mp4',
      mime_type: 'video/mp4',
      declared_size: 1024,
      storage_key: `videos/${id}/original.mp4`,
      ...overrides,
    });
  }

  it('should default status to draft and leave processing fields null', async () => {
    const channel = await createChannel();

    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.failure_reason).toBeNull();
    expect(found.file_size).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.upload_id).toBeNull();
    expect(found.duration_seconds).toBeNull();
  });

  it('should read bigint columns back as numbers', async () => {
    const channel = await createChannel();
    const tenGiB = 10 * 1024 * 1024 * 1024;

    const saved = await videoRepository.save(
      buildVideo(channel.id, { declared_size: tenGiB, file_size: tenGiB - 1 }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.declared_size).toBe(tenGiB);
    expect(found.file_size).toBe(tenGiB - 1);
  });

  it('should enforce a unique public_id', async () => {
    const channel = await createChannel();
    const publicId = generatePublicId();
    await videoRepository.save(buildVideo(channel.id, { public_id: publicId }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { public_id: publicId })),
    ).rejects.toThrow();
  });

  it('should reject a video whose channel does not exist', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID())),
    ).rejects.toThrow();
  });

  it('should reject an invalid status value', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        buildVideo(channel.id, { status: 'archived' as VideoStatus }),
      ),
    ).rejects.toThrow();
  });

  it('should load the owning channel through the relation', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });

    expect(found.channel.nickname).toBe(channel.nickname);
  });
});
