import { randomBytes, randomUUID } from 'crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import type { ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { deleteObjectsByPrefix } from '../test/storage';
import { S3_INTERNAL_CLIENT } from './storage.constants';
import { MultipartCompletionError } from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024;

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let client: S3Client;
  let config: ConfigType<typeof storageConfig>;
  let prefix: string;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    client = module.get(S3_INTERNAL_CLIENT);
    config = module.get(storageConfig.KEY);
  });

  beforeEach(() => {
    prefix = `videos/test-${randomUUID()}/`;
  });

  afterEach(async () => {
    await deleteObjectsByPrefix(client, config.bucket, prefix);
  });

  afterAll(async () => {
    await module.close();
  });

  async function putPart(url: string, body: Buffer): Promise<string> {
    const response = await fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
    });
    expect(response.status).toBe(200);
    return response.headers.get('etag')!;
  }

  async function uploadTwoParts(key: string, uploadId: string) {
    const first = randomBytes(MIN_PART_SIZE);
    const second = randomBytes(1024);
    const etag1 = await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 60),
      first,
    );
    const etag2 = await putPart(
      await storage.presignUploadPart(key, uploadId, 2, 60),
      second,
    );
    return {
      parts: [
        { partNumber: 1, etag: etag1 },
        { partNumber: 2, etag: etag2 },
      ],
      size: first.length + second.length,
    };
  }

  it('should accept presigned part uploads and list them in ascending order', async () => {
    const key = `${prefix}original.mp4`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

    const { parts } = await uploadTwoParts(key, uploadId);
    const listed = await storage.listParts(key, uploadId);

    expect(listed.map((p) => p.partNumber)).toEqual([1, 2]);
    expect(listed.map((p) => p.etag)).toEqual(parts.map((p) => p.etag));
    expect(listed.map((p) => p.size)).toEqual([MIN_PART_SIZE, 1024]);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('should complete an upload whose parts are given out of order', async () => {
    const key = `${prefix}original.mp4`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { parts, size } = await uploadTwoParts(key, uploadId);

    await storage.completeMultipartUpload(key, uploadId, [...parts].reverse());

    await expect(storage.headObject(key)).resolves.toEqual({
      contentLength: size,
    });
  });

  it('should serve a presigned GET with Range as 206 Partial Content', async () => {
    const key = `${prefix}original.mp4`;
    await storage.putObject(key, randomBytes(4096), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      signer: 'public',
      expiresIn: 60,
    });
    const response = await fetch(url, { headers: { Range: 'bytes=0-99' } });
    const body = Buffer.from(await response.arrayBuffer());

    expect(response.status).toBe(206);
    expect(body.length).toBe(100);
  });

  it('should force a download via Content-Disposition on the presigned URL', async () => {
    const key = `${prefix}original.mp4`;
    await storage.putObject(key, randomBytes(128), 'video/mp4');

    const url = await storage.presignGetObject(key, {
      signer: 'public',
      expiresIn: 60,
      downloadFileName: 'my clip.mp4',
    });
    const response = await fetch(url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="my clip.mp4"',
    );
  });

  it('should raise MultipartCompletionError for an unknown ETag and leave no object', async () => {
    const key = `${prefix}original.mp4`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const { parts } = await uploadTwoParts(key, uploadId);

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        parts[0],
        { partNumber: 2, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(MultipartCompletionError);
    await expect(storage.headObject(key)).rejects.toBeDefined();

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('should abort an upload so it can no longer be listed or completed', async () => {
    const key = `${prefix}original.mp4`;
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toMatchObject({
      name: 'NoSuchUpload',
    });
  });

  it('should delete an object', async () => {
    const key = `${prefix}thumbnail.jpg`;
    await storage.putObject(key, Buffer.from('x'), 'image/jpeg');

    await storage.deleteObject(key);

    await expect(storage.headObject(key)).rejects.toBeDefined();
  });

  it('should sign URLs for the public endpoint, not the internal one', async () => {
    const publicModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue({ ...config, publicEndpoint: 'http://public.example:9000' })
      .compile();
    const service = publicModule.get(StorageService);

    const publicUrl = await service.presignGetObject('videos/x/original.mp4', {
      signer: 'public',
      expiresIn: 60,
    });
    const internalUrl = await service.presignGetObject(
      'videos/x/original.mp4',
      { signer: 'internal', expiresIn: 60 },
    );

    expect(new URL(publicUrl).origin).toBe('http://public.example:9000');
    expect(new URL(internalUrl).origin).toBe(new URL(config.endpoint).origin);
    await publicModule.close();
  });
});
