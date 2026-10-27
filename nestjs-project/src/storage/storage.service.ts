import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import {
  MULTIPART_COMPLETION_ERROR_NAMES,
  S3_INTERNAL_CLIENT,
  S3_SIGNING_CLIENT,
} from './storage.constants';
import { MultipartCompletionError } from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface UploadedPartInfo extends UploadedPart {
  size: number;
}

export interface PresignGetOptions {
  signer: 'public' | 'internal';
  expiresIn: number;
  downloadFileName?: string;
}

@Injectable()
export class StorageService {
  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_SIGNING_CLIENT) private readonly signingClient: S3Client,
    @Inject(storageConfig.KEY)
    private readonly storage: ConfigType<typeof storageConfig>,
  ) {}

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const { UploadId } = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number,
  ): Promise<string> {
    return getSignedUrl(
      this.signingClient,
      new UploadPartCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPartInfo[]> {
    const parts: UploadedPartInfo[] = [];
    let partNumberMarker: string | undefined;

    do {
      const page = await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.storage.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumberMarker: partNumberMarker,
        }),
      );
      for (const part of page.Parts ?? []) {
        parts.push({
          partNumber: part.PartNumber!,
          etag: part.ETag!,
          size: part.Size ?? 0,
        });
      }
      partNumberMarker = page.IsTruncated
        ? page.NextPartNumberMarker
        : undefined;
    } while (partNumberMarker);

    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadedPart[],
  ): Promise<void> {
    // S3 requires ascending, unique part numbers (InvalidPartOrder otherwise).
    const unique = new Map<number, UploadedPart>();
    for (const part of parts) {
      unique.set(part.partNumber, part);
    }
    const ordered = [...unique.values()].sort(
      (a, b) => a.partNumber - b.partNumber,
    );

    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.storage.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: ordered.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
          },
        }),
      );
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (
        MULTIPART_COMPLETION_ERROR_NAMES.includes(
          name as (typeof MULTIPART_COMPLETION_ERROR_NAMES)[number],
        )
      ) {
        throw new MultipartCompletionError(name!, { cause: error });
      }
      throw error;
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.internalClient.send(
      new AbortMultipartUploadCommand({
        Bucket: this.storage.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<{ contentLength: number }> {
    const { ContentLength } = await this.internalClient.send(
      new HeadObjectCommand({ Bucket: this.storage.bucket, Key: key }),
    );
    return { contentLength: ContentLength ?? 0 };
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.storage.bucket, Key: key }),
    );
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async presignGetObject(
    key: string,
    { signer, expiresIn, downloadFileName }: PresignGetOptions,
  ): Promise<string> {
    const client =
      signer === 'public' ? this.signingClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.storage.bucket,
        Key: key,
        ...(downloadFileName !== undefined && {
          ResponseContentDisposition: `attachment; filename="${downloadFileName.replace(/"/g, '\\"')}"`,
        }),
      }),
      { expiresIn },
    );
  }
}
