import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

function createClient(
  storage: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: {
      accessKeyId: storage.accessKey,
      secretAccessKey: storage.secretKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

@Module({
  providers: [
    {
      provide: S3_INTERNAL_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        createClient(storage, storage.endpoint),
    },
    {
      provide: S3_SIGNING_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (storage: ConfigType<typeof storageConfig>) =>
        createClient(storage, storage.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService, S3_INTERNAL_CLIENT],
})
export class StorageModule {}
