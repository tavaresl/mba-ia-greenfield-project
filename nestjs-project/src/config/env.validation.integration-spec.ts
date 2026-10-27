import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and videos keys', () => {
  it('should reject a missing S3_ACCESS_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_ACCESS_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error!.message).toContain('S3_ACCESS_KEY');
  });

  it('should reject a missing S3_SECRET_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_SECRET_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    );
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should reject VIDEO_MAX_UPLOAD_BYTES above 10 GiB', () => {
    const { error } = validate({ VIDEO_MAX_UPLOAD_BYTES: '10737418241' });
    expect(error!.message).toContain('VIDEO_MAX_UPLOAD_BYTES');
  });

  it('should reject VIDEO_UPLOAD_PART_SIZE_BYTES below 5 MiB', () => {
    const { error } = validate({ VIDEO_UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error!.message).toContain('VIDEO_UPLOAD_PART_SIZE_BYTES');
  });

  it('should apply the documented defaults', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value as Record<string, unknown>).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube',
      S3_UPLOAD_URL_TTL_SECONDS: 3600,
      S3_DOWNLOAD_URL_TTL_SECONDS: 14400,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'bull',
      VIDEO_MAX_UPLOAD_BYTES: 10737418240,
      VIDEO_UPLOAD_PART_SIZE_BYTES: 104857600,
    });
  });
});
