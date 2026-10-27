import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_SIGNING_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and expose the service and two distinct S3 clients', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    expect(module.get(S3_INTERNAL_CLIENT)).not.toBe(
      module.get(S3_SIGNING_CLIENT),
    );
    await module.close();
  }, 15000);
});
