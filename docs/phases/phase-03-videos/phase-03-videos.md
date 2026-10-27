---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-26T21:01:38-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-26T21:02:09-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-26T21:00:16-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-24T16:34:56-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload and processing in `nestjs-project`: S3-compatible object storage for videos and thumbnails, a background processing queue consumed by a separate video worker, uploads of up to 10GB sent directly to storage without impacting API performance, automatic draft pre-registration when the upload starts, automatic extraction of duration and metadata plus thumbnail generation after upload, a unique short URL identifier per video, and streaming (HTTP Range, no full download required) and download of the video — fulfilling the deliverables "upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas".

---

## Step Implementations

### SI-03.1 — Infra: Storage and Queue Services, Dependencies, and Configuration Namespaces

**Description:** Add the S3-compatible storage (MinIO via `pgsty/silo`) and Redis services to Docker Compose with a one-shot bucket bootstrap, install the storage/queue libraries, and create the `storage` and `queue` configuration namespaces with Joi validation — the infrastructure every later SI builds on.

**Technical actions:**

1. Install production dependencies in `nestjs-project` (inside the container): `@aws-sdk/client-s3@^3.1157.0`, `@aws-sdk/s3-request-presigner@^3.1157.0` (per `phase-03-videos/TD-02`), `@nestjs/bullmq@^11.0.5`, `bullmq@^6.5.0` (per `phase-03-videos/TD-04`) — versions and the "stay on `@nestjs/bullmq` 11.x" constraint per `library-refs.md`.
2. Add services to `nestjs-project/compose.yaml`: `minio` — image `pgsty/silo:RELEASE.2026-10-18T00-00-00Z` (standard variant, never `latest`/`-distroless`), command `server /data --console-address ":9001"`, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, ports `9000:9000` and `9001:9001`, named volume for `/data`, `curl` healthcheck on `/minio/health/live` (per `phase-03-videos/TD-12`); `minio-init` — same image, one-shot entrypoint running `mc alias set` + `mc mb --ignore-existing local/${S3_BUCKET}`, `depends_on: minio (service_healthy)`; `redis` — pinned `redis:7.4-alpine` with a `redis-cli ping` healthcheck (per `phase-03-videos/TD-04`). Make `nestjs-api` depend on `minio-init (service_completed_successfully)` and `redis (service_healthy)` so the bucket exists before any storage call (per `phase-03-videos/TD-12` — `NoSuchBucket` caution).
3. Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (default `'http://minio:9000'`, in-network), `S3_PUBLIC_ENDPOINT` (default `'http://localhost:9000'`, client-reachable — used only to sign URLs consumed outside the Compose network), `S3_REGION` (default `'us-east-1'`), `S3_ACCESS_KEY`, `S3_SECRET_KEY` (required), `S3_BUCKET` (default `'streamtube'`), `S3_UPLOAD_URL_TTL_SECONDS` (default `3600`), `S3_DOWNLOAD_URL_TTL_SECONDS` (default `14400`); `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (default `'redis'`), `REDIS_PORT` (default `6379`), `QUEUE_PREFIX` (default `'bull'`); and `src/config/videos.config.ts` — `registerAs('videos', ...)` reading `VIDEO_MAX_UPLOAD_BYTES` (default `10737418240`, the TD-11 limit) and `VIDEO_UPLOAD_PART_SIZE_BYTES` (default `104857600`) — following `phase-01-configuracao-base/TD-03`.
4. Extend `src/config/env.validation.ts` (Joi, per `phase-01-configuracao-base/TD-02`) with every new key (`S3_ACCESS_KEY`/`S3_SECRET_KEY` required; `VIDEO_MAX_UPLOAD_BYTES` integer 1–10737418240 so it can never exceed the 10 GiB limit of `phase-03-videos/TD-11`; `VIDEO_UPLOAD_PART_SIZE_BYTES` integer 5242880–5368709120, the S3 part-size bounds; others with the defaults above), add `storageConfig`, `queueConfig` and `videosConfig` to `ConfigModule.forRoot({ load })` in `src/app.module.ts`, and document all keys in `.env.example` (service names as hosts; comment that `S3_PUBLIC_ENDPOINT` is the only host-facing value).
5. Create `src/test/setup-test-env.ts` — loaded after `dotenv/config` in both `package.json` jest `setupFiles` and `test/jest-e2e.json` — that sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (tests run inside the Compose network and must reach presigned URLs; per `phase-03-videos/TD-12` revision, IC-1), `QUEUE_PREFIX = 'test'` (isolates test jobs from the running worker), `VIDEO_UPLOAD_PART_SIZE_BYTES = 5242880` and `VIDEO_MAX_UPLOAD_BYTES = 12582912` (multi-part uploads and the size-limit path become testable with a few MiB instead of 100 MiB / 10 GiB).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (storage/queue/videos keys) | Integration: missing `S3_ACCESS_KEY` / `S3_SECRET_KEY` rejected; `VIDEO_MAX_UPLOAD_BYTES` above 10 GiB and `VIDEO_UPLOAD_PART_SIZE_BYTES` below 5 MiB rejected; defaults applied | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` from `nestjs-project/` brings up `db`, `mailpit`, `minio`, `redis` and `nestjs-api`; `minio-init` exits with code 0 and `docker compose ps` shows `minio` and `redis` as healthy
- After `minio-init` completes, the bucket named by `S3_BUCKET` exists in MinIO (listing it with `mc ls` succeeds)
- Bootstrapping the application without `S3_ACCESS_KEY` fails Joi validation and the app does not start
- Bootstrapping with `VIDEO_MAX_UPLOAD_BYTES=10737418241` or `VIDEO_UPLOAD_PART_SIZE_BYTES=1048576` fails Joi validation; without them the defaults `10737418240` and `104857600` apply
- The MinIO console answers on `http://localhost:9001` from the host
- The pre-existing test suites (unit, integration, e2e) still pass with the new services running

---

### SI-03.2 — Storage Module (S3 Clients, Multipart and Presigned Operations)

**Description:** Encapsulate every object-storage interaction in a `StorageModule` shared by the API and the worker — multipart lifecycle, presigned part/GET URLs, metadata and object I/O — so no other module talks to the S3 SDK directly.

**Technical actions:**

1. Create `src/storage/storage.module.ts` with two `S3Client` providers built from `storageConfig` (per `phase-03-videos/TD-02`): an **internal** client (`endpoint: S3_ENDPOINT`) for server-side calls and a **signing** client (`endpoint: S3_PUBLIC_ENDPOINT`) used only by the presigner — both `forcePathStyle: true`, fixed `region`, static credentials, and `requestChecksumCalculation` / `responseChecksumValidation` set to `'WHEN_REQUIRED'` (per `library-refs.md` → `@aws-sdk/client-s3` data-integrity caution). One instance each, reused (no per-call clients).
2. Create `src/storage/storage.service.ts` exposing: `createMultipartUpload(key, contentType)` → `uploadId`; `presignUploadPart(key, uploadId, partNumber, expiresIn)`; `listParts(key, uploadId)` (paginated, ascending); `completeMultipartUpload(key, uploadId, parts)` — sorts ascending and de-duplicates by `PartNumber` before sending (per `phase-03-videos/TD-12` — `InvalidPartOrder`); `abortMultipartUpload`; `headObject(key)` → `ContentLength`; `deleteObject`; `putObject(key, body, contentType)`; `presignGetObject(key, { signer: 'public' | 'internal', expiresIn, downloadFileName? })` — sets `ResponseContentDisposition: attachment; filename="…"` when `downloadFileName` is given (per `phase-03-videos/TD-08`). Bucket name always from `S3_BUCKET` (per `phase-03-videos/TD-01`).
3. Map S3 service errors `InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload` raised by `completeMultipartUpload` to a storage-level `MultipartCompletionError` (exported by the module) so callers translate it to `INVALID_UPLOAD_PARTS` without importing SDK types.
4. Create `src/test/storage.ts` — test helper that deletes every object under a given key prefix in the bucket (used in `afterEach` of storage-touching suites).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (real MinIO): multipart create → presigned `UploadPart` PUT via `fetch` (one ≥5 MiB part + small last part) → `listParts` → complete with parts given in descending order → `headObject` size; presigned GET with `Range` returns `206`; download URL carries `Content-Disposition: attachment`; wrong ETag → `MultipartCompletionError`; abort | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilation test with real config | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — libraries, `storage` config namespace and the bucket must exist

**Acceptance criteria:**

- A `PUT` to a presigned `UploadPart` URL returns `200` with an `ETag` header, and the part then appears in `listParts`
- Completing a multipart upload with its parts listed out of order succeeds, and `headObject` reports the sum of the part sizes
- A presigned GET requested with `Range: bytes=0-99` returns `206 Partial Content` with exactly 100 bytes
- A presigned download URL response carries `Content-Disposition: attachment; filename="<name>"`
- Completing with an ETag that does not match an uploaded part raises `MultipartCompletionError` and leaves no object at the key
- Presigned URLs are issued for the `S3_PUBLIC_ENDPOINT` host; server-side calls go to `S3_ENDPOINT`

---

### SI-03.3 — Video Entity, CreateVideos Migration, and Public ID Generator

**Description:** Create the `Video` entity linked to `Channel` exactly as the Data Model specifies, generate the `CreateVideos` migration, and add the short public-ID generator used for the unique video URL.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` per `### Data Model → Video`: `@PrimaryGeneratedColumn('uuid') id`, `public_id varchar(11)` unique, `channel_id` with `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })`, `status` enum (`'draft' | 'processing' | 'ready' | 'failed'`, default `'draft'`, per `phase-03-videos/TD-10`), the upload/storage columns (per `phase-03-videos/TD-01`, `TD-03`, `TD-11`) and the typed metadata columns (per `phase-03-videos/TD-06` revision, AMB-3); `bigint` columns (`declared_size`, `file_size`) with a transformer to `number`.
2. Generate `src/database/migrations/<timestamp>-CreateVideos.ts` with `npm run migration:generate` — `videos_status_enum` type, `videos` table, unique index on `public_id`, index on `channel_id`, FK `channel_id → channels.id`; `down` drops them in reverse order.
3. Create `src/videos/public-id.util.ts` — `generatePublicId()` returning `crypto.randomBytes(8).toString('base64url')` (11 URL-safe chars; per `phase-03-videos/TD-09`).
4. Update `cleanAllTables` in `src/test/create-test-data-source.ts` to delete from `"videos"` before `"channels"` (FK order).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: unique `public_id`, FK to `channels`, `status` default `'draft'`, `bigint` read back as `number` | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: 11 chars, base64url alphabet only, distinct values across calls | `src/videos/public-id.util.spec.ts` |
| Migrations | Integration: after running all migrations the `videos` table, enum and indexes exist; revert removes them | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- Running `npm run migration:run` creates the `videos` table with enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) and a unique index on `public_id`
- Inserting two videos with the same `public_id` fails with a unique-constraint violation
- Inserting a video whose `channel_id` does not exist fails with a foreign-key violation
- A video inserted without `status` is persisted as `'draft'`
- `npm run migration:revert` removes the `videos` table and `videos_status_enum`

---

### SI-03.4 — Processing Queue Registration, Producer, and VideosModule

**Description:** Connect the application to Redis through `@nestjs/bullmq`, register the `video-processing` queue with the job contract from `### Events/Messages`, and create the `VideosModule` that owns the producer.

**Technical actions:**

1. Register `BullModule.forRootAsync` in `src/app.module.ts`, injecting `queueConfig.KEY` (not raw `ConfigService`, per `phase-01-configuracao-base/TD-03`) and returning `{ connection: { host, port }, prefix }` (per `phase-03-videos/TD-04`; `connection` key per `library-refs.md` → `@nestjs/bullmq`).
2. Create `src/videos/video-processing.constants.ts` — `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, `ProcessVideoJobData { videoId: string }` and the default job options `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false }` (per `### Events/Messages`, `phase-03-videos/TD-10`).
3. Create `src/videos/video-processing.producer.ts` — `@InjectQueue(VIDEO_PROCESSING_QUEUE)`; `enqueue(videoId)` adds `PROCESS_VIDEO_JOB` with payload `{ videoId }` and `jobId: videoId` (BullMQ de-duplication).
4. Create `src/videos/videos.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; provides the producer; register `VideosModule` in `AppModule`. The `VideoProcessor` is NOT provided here (it lives only in the worker, per `phase-03-videos/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (real Redis, `QUEUE_PREFIX=test`): `enqueue` creates one waiting `process-video` job with payload `{ videoId }`, `jobId = videoId` and the configured attempts/backoff; a second `enqueue` with the same id does not create a duplicate | `src/videos/video-processing.producer.integration-spec.ts` |
| `VideosModule` | Unit: compilation test (`BullModule.registerQueue`, `TypeOrmModule.forFeature`, `StorageModule` wiring) | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — Redis service and `queue` config; SI-03.2 — `StorageModule`; SI-03.3 — `Video` entity

**Acceptance criteria:**

- `enqueue(videoId)` results in exactly one job named `process-video` in the `video-processing` queue, with payload `{ "videoId": "<uuid>" }`, `attempts: 3` and exponential backoff of 5000 ms
- Calling `enqueue` twice with the same `videoId` while the first job exists leaves a single job in the queue
- Jobs enqueued while `QUEUE_PREFIX=test` are stored under the `test` prefix and are not visible under the default `bull` prefix
- The application boots with `VideosModule` registered and Redis reachable at the `redis` service host

---

### SI-03.5 — Endpoint POST /videos (Draft Pre-registration and Upload Initiation)

**Route:** POST /videos
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Authenticated — video is created in the caller's channel (per `### Authorization Matrix`)

**Description:** Pre-register the video as `draft` when the upload starts and open the S3 multipart upload, returning the part plan the client uses to send the file directly to storage.

**Technical actions:**

1. Create `src/videos/dto/create-video.dto.ts` — `title`, `file_name`, `file_size`, `mime_type` per `### API Contracts → POST /videos` and `#### Validation Rules — Videos` (class-validator, per `phase-02-auth/TD-06`; payload per `phase-03-videos/TD-03` revision, AMB-2).
2. Add the Phase 03 domain exceptions to `src/common/exceptions/domain.exception.ts` per `### Error Catalog`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoNotUploadableException` (`VIDEO_NOT_UPLOADABLE`, 409), `InvalidUploadPartsException` (`INVALID_UPLOAD_PARTS`, 422), `UploadSizeExceededException` (`UPLOAD_SIZE_EXCEEDED`, 422), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409), `InvalidPartNumbersException` (`VALIDATION_ERROR`, 400) (per `phase-02-auth/TD-07`).
3. Create `src/videos/videos.service.ts` with `createDraft(userId, dto)`: resolve the caller's channel by `user_id`; generate the internal id (`crypto.randomUUID()`) so `storage_key = videos/{id}/original.{mp4|webm}` is known before insert (per `phase-03-videos/TD-01`); insert the `draft` row with `public_id` from `generatePublicId()`, retrying on unique violation of `public_id` up to 5 times (same pattern as `ChannelsService`, per `phase-03-videos/TD-09`); call `createMultipartUpload` and store `upload_id` (per `phase-03-videos/TD-03`) — if storage fails, delete the row and rethrow; return `part_size` from `videosConfig` (`VIDEO_UPLOAD_PART_SIZE_BYTES`) and `part_count = ceil(file_size / part_size)`.
4. Create `src/videos/videos.controller.ts` (`@Controller('videos')`, class-level `@SkipThrottle()` — the `APP_GUARD` throttler from `AuthModule` is application-wide, see `### API Contracts` intro) with `POST /videos` returning `201`, documented with `@ApiTags('videos')`, `@ApiBearerAuth`, `@ApiOperation` and `@ApiResponse` per status using `ApiErrorEnvelope` (per `openapi-docs-nestjs/TD-01` revision); register the controller in `VideosModule`. Video E2E suites reset the throttler storage in `beforeEach` (as `test/auth.e2e-spec.ts` does), since obtaining access tokens still goes through the throttled auth endpoints.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.createDraft` | Unit (mock repositories/storage, default `videos` config): retries `public_id` on unique violation and gives up after 5 attempts; deletes the row when `createMultipartUpload` fails; `file_size` 10737418240 at the default part size yields `part_count` 103 | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration (real DB + MinIO): persists a `draft` row in the caller's channel with `declared_size`, `mime_type`, `original_file_name`, non-null `upload_id` and `storage_key` matching `videos/{id}/original.{ext}` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — `VideosModule` and queue wiring; SI-03.2 — `StorageService`; SI-03.3 — `Video` entity and public-ID generator

**Acceptance criteria:**

- `POST /videos` with a valid body and access token returns `201` with an 11-character `id`, the `title`, `status: "draft"`, `part_size` equal to `VIDEO_UPLOAD_PART_SIZE_BYTES` and `part_count = ceil(file_size / part_size)`
- With the default part size (104857600), a declared `file_size` of 10737418240 (10 GiB) is accepted and yields `part_count: 103` — within the 10,000-part S3 limit
- After the call, a `videos` row exists with `status = 'draft'`, `channel_id` = the caller's channel, a non-null `upload_id` and `storage_key` `videos/{id}/original.mp4` for `video/mp4`
- `POST /videos` with `file_size: 10737418241` returns `400` with `error: "VALIDATION_ERROR"`
- `POST /videos` with `mime_type: "video/quicktime"` returns `400` with `error: "VALIDATION_ERROR"`
- `POST /videos` without an access token returns `401`
- Two consecutive `POST /videos` calls return different `id` values
- More than 10 requests within one minute to `/videos` endpoints by the same client are not rejected with `429`

---

### SI-03.6 — Endpoints for Part Signing, Resume Listing, and Upload Cancellation

**Route:** POST /videos/:publicId/upload/parts, GET /videos/:publicId/upload/parts, DELETE /videos/:publicId/upload
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner only — non-owner and unknown ids both return `404 VIDEO_NOT_FOUND` (per `### Authorization Matrix`)

**Description:** Let the owner obtain presigned URLs for the upload parts, list the parts already stored to resume after a connection failure, and cancel an open upload — all without any video bytes touching the API.

**Technical actions:**

1. Create `src/videos/dto/sign-upload-parts.dto.ts` — `part_numbers` per `#### Validation Rules — Videos` (array, 1–100 unique positive integers).
2. Add `findOwnedOrFail(userId, publicId)` to `VideosService` — loads by `public_id` joined to the owner channel; throws `VideoNotFoundException` when missing or owned by another channel (per `### Authorization Matrix`; owner-only per `phase-03-videos/TD-08` revision, AMB-1).
3. Add `signUploadParts(userId, publicId, partNumbers)` (requires `status = 'draft'` and non-null `upload_id`, else `VideoNotUploadableException`; any part number > `part_count` → `InvalidPartNumbersException`; presigns each part with `S3_UPLOAD_URL_TTL_SECONDS` via the signing client, per `phase-03-videos/TD-03`), `listUploadedParts(userId, publicId)` (same preconditions; returns `listParts` ascending) and `cancelUpload(userId, publicId)` (requires `draft`; `abortMultipartUpload` when `upload_id` is set, then deletes the row).
4. Add the three routes to `VideosController` with their status codes (`200`, `200`, `204`) and Swagger decorators per `### API Contracts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (sign/list/cancel) | Unit (mock repositories/storage): non-owner → `VideoNotFoundException`; non-`draft` or null `upload_id` → `VideoNotUploadableException`; part number above `part_count` → `InvalidPartNumbersException`; cancel without `upload_id` skips the abort | `src/videos/videos.service.spec.ts` |
| `VideosService` (sign/list/cancel) | Integration (real DB + MinIO): signed part URL accepts a `PUT`, the part then appears in `listUploadedParts`; `cancelUpload` aborts the multipart upload and deletes the row | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — `VideosService`, controller and draft creation

**Acceptance criteria:**

- `POST /videos/:publicId/upload/parts` with `{ part_numbers: [1, 2] }` on the owner's `draft` video returns `200` with two `{ part_number, url }` entries and `expires_in` equal to `S3_UPLOAD_URL_TTL_SECONDS`
- `PUT` of the part bytes to a returned `url` succeeds, and `GET /videos/:publicId/upload/parts` then lists that part with its `etag` and `size`
- `POST /videos/:publicId/upload/parts` with a part number greater than the video's `part_count` returns `400` with `error: "VALIDATION_ERROR"`
- Any of the three routes called by a different authenticated user returns `404` with `error: "VIDEO_NOT_FOUND"` — indistinguishable from a non-existent id
- Any of the three routes on a video whose status is not `draft` returns `409` with `error: "VIDEO_NOT_UPLOADABLE"`
- `DELETE /videos/:publicId/upload` returns `204`; afterwards the `videos` row no longer exists and the multipart upload is no longer listed in storage

---

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete (Completion, Size Check, and Enqueue)

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner only (per `### Authorization Matrix`)

**Description:** Close the multipart upload, enforce the real 10 GiB limit on the assembled object, move the video `draft → processing` and publish the processing job — the hand-off point between upload and background processing.

**Technical actions:**

1. Create `src/videos/dto/complete-upload.dto.ts` — `parts` array of `{ part_number, etag }` per `#### Validation Rules — Videos` (`@ValidateNested` + `@Type`).
2. Add `completeUpload(userId, publicId, parts)` to `VideosService`: owner check (`findOwnedOrFail`); `status != 'draft'` → `VideoNotUploadableException`; when `upload_id` is set, call `completeMultipartUpload` (sorted, de-duplicated — per `phase-03-videos/TD-12`) and translate `MultipartCompletionError` → `InvalidUploadPartsException`, then clear `upload_id` (so a retry skips this step); `headObject` → when `ContentLength > VIDEO_MAX_UPLOAD_BYTES` (from `videosConfig`, default 10737418240), delete the object, set `status = 'failed'`, `failure_reason = 'UPLOAD_SIZE_EXCEEDED'` and throw `UploadSizeExceededException` (per `phase-03-videos/TD-11`).
3. In the same method: conditional update `draft → processing` setting `file_size` (per `phase-03-videos/TD-10`), then `VideoProcessingProducer.enqueue(video.id)` (per `phase-03-videos/TD-04`); if enqueueing throws, revert `processing → draft` and rethrow so the client can retry (per `### Events/Messages → Producer`).
4. Add the route to `VideosController` returning `202` with `{ id, status: "processing" }` and Swagger decorators per `### API Contracts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mock repositories/storage/producer): storage rejection → `InvalidUploadPartsException`; oversize → object deleted + `failed`/`UPLOAD_SIZE_EXCEEDED`; enqueue failure → status reverted to `draft`; null `upload_id` skips `completeMultipartUpload`; non-`draft` → `VideoNotUploadableException` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (real DB + MinIO + Redis, test config: 5 MiB parts, 12 MiB limit): parts uploaded through presigned URLs and completed out of order → row `processing` with `file_size` set, `upload_id` null, object present, one `process-video` job for the video; three 5 MiB parts (15 MiB) → `UploadSizeExceededException`, object removed, video `failed` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.6 — owner lookup and part signing; SI-03.4 — `VideoProcessingProducer`

**Acceptance criteria:**

- `POST /videos/:publicId/upload/complete` with the ETags of all uploaded parts returns `202` with `{ "id": "<publicId>", "status": "processing" }`
- After completion the `videos` row has `status = 'processing'`, `file_size` equal to the stored object size and `upload_id = null`, and one `process-video` job with payload `{ videoId }` exists in `video-processing`
- Completing with an ETag that does not belong to an uploaded part returns `422` with `error: "INVALID_UPLOAD_PARTS"` and the video stays `draft`
- When the assembled object exceeds `VIDEO_MAX_UPLOAD_BYTES` (10737418240 by default) the endpoint returns `422` with `error: "UPLOAD_SIZE_EXCEEDED"`, the object is removed from storage and the video is `failed` with `failure_reason = 'UPLOAD_SIZE_EXCEEDED'`
- Calling complete again on a video already `processing` returns `409` with `error: "VIDEO_NOT_UPLOADABLE"` and no second job is created
- A request without a `parts` array returns `400` with `error: "VALIDATION_ERROR"`

---

### SI-03.8 — Infra: Video Worker Image, Entrypoint, and Compose Service

**Description:** Create the separate video-worker process from the same codebase — its own FFmpeg-equipped image, a standalone Nest application context and a Compose service that starts with the backend — while the API image stays FFmpeg-free.

**Technical actions:**

1. Create `nestjs-project/Dockerfile.worker.dev` — same base as `Dockerfile.dev` (`node:25.6.0-slim`) plus `ffmpeg` (provides `ffmpeg` and `ffprobe`), `procps` and `curl` via apt; runs as `node` in `/home/node/app` (per `phase-03-videos/TD-05`, `TD-06`). `Dockerfile.dev` (API) is not changed.
2. Extract the shared bootstrap options so the API and the worker do not duplicate connection parameters (inherited convention: database parameters come from a single `databaseConfig` factory, never duplicated between modules): `src/config/config-module.options.ts` (the `ConfigModule.forRoot` options: `isGlobal`, `load`, `validationSchema`), `src/database/typeorm.options.ts` (the `TypeOrmModule.forRootAsync` options) and `src/queue/bull.options.ts` (the `BullModule.forRootAsync` options); make `AppModule` consume them.
3. Create `src/worker/worker.module.ts` (imports the three shared root modules) and `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` with `enableShutdownHooks()`; no HTTP listener (per `phase-03-videos/TD-05`).
4. Add npm scripts `start:worker` (`node dist/worker`) and `start:worker:dev` (Nest watch build of the `worker` entry file using a separate compile output directory, so the API and worker watchers never overwrite each other's `dist` output).
5. Add the `video-worker` service to `nestjs-project/compose.yaml` — built from `Dockerfile.worker.dev`, same bind mount as `nestjs-api`, `command: npm run start:worker:dev`, `restart: unless-stopped`, `depends_on` `db (service_healthy)`, `redis (service_healthy)`, `minio-init (service_completed_successfully)`; service names as hosts (`db`, `redis`, `minio`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (shared Config/TypeORM/Bull options resolve) | `src/worker/worker.module.spec.ts` |
| `AppModule` (shared options) | E2E regression: existing `test/app.e2e-spec.ts` still boots the API with the extracted options | `test/app.e2e-spec.ts` |

**Dependencies:** SI-03.1 — Redis, MinIO bootstrap and `queue` config; SI-03.4 — `BullModule` root configuration being extracted

**Acceptance criteria:**

- `docker compose up -d` starts `video-worker` together with the backend services and `docker compose ps` shows it running (not restarting)
- `docker compose exec video-worker ffprobe -version` succeeds, while `docker compose exec nestjs-api ffprobe -version` fails (API image has no FFmpeg)
- The worker log shows the Nest application context initialized with no HTTP port bound
- With both `nestjs-api` (`npm run start:dev`) and `video-worker` watchers running, editing a source file rebuilds both without either process crashing on missing compiled files

---

### SI-03.9 — Media Module: Typed ffprobe/ffmpeg Wrapper and Accepted-Format Policy

**Description:** Provide the worker with a small typed wrapper over the system `ffprobe`/`ffmpeg` binaries — metadata extraction and single-frame thumbnail — plus the policy that decides which media are web-playable.

**Technical actions:**

1. Create `src/media/ffmpeg.service.ts` — `probe(input)` spawns `ffprobe -v error -print_format json -show_format -show_streams <input>` via `child_process.spawn` and parses the JSON into a typed `MediaProbe` (`durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec` (nullable), `containerFormat`, `bitrate`) matching the Data Model metadata columns (per `phase-03-videos/TD-06` and its revision, AMB-3); `extractThumbnail(input, atSeconds)` spawns `ffmpeg -ss <t> -i <input> -frames:v 1 -f image2 -c:v mjpeg pipe:1` and returns the JPEG `Buffer`. `<input>` may be an HTTP(S) presigned URL. No `fluent-ffmpeg` (per `phase-03-videos/TD-06`).
2. Handle process failures in the wrapper: non-zero exit or unparsable output → `MediaProbeError` / `MediaProcessingError` carrying the trimmed stderr; a configurable timeout (`AbortController`) kills the child and raises `MediaProcessingError`.
3. Create `src/media/media-format.policy.ts` — `isSupportedMedia(probe, mimeType)`: `video/mp4` requires an `h264` video stream and an `aac` audio stream or none; `video/webm` requires `vp8`/`vp9`/`av1` video and `vorbis`/`opus` audio or none (per `phase-03-videos/TD-07`).
4. Create `src/media/media.module.ts` exporting `FfmpegService`, and `src/test/media-fixtures.ts` — test helper that generates short sample files with `ffmpeg -f lavfi` (`testsrc` + `sine`) in a temp dir: valid H.264/AAC MP4, valid VP9/Opus WebM, and an unsupported MP4 (`mpeg4` codec).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `FfmpegService` | Integration (real FFmpeg binaries — runs in the `video-worker` container): probe of generated MP4/WebM returns duration, dimensions and codecs; thumbnail returns a non-empty JPEG (`FF D8` magic); probing a non-media file raises `MediaProbeError` | `src/media/ffmpeg.service.integration-spec.ts` |
| `isSupportedMedia` | Unit: accepted and rejected codec/container combinations for both MIME types, including "no audio stream" | `src/media/media-format.policy.spec.ts` |

**Dependencies:** SI-03.8 — `video-worker` image with FFmpeg (where the integration tests run)

**Acceptance criteria:**

- Probing a generated 3-second 640×360 H.264/AAC MP4 returns `durationSeconds` ≈ 3, `width` 640, `height` 360, `videoCodec` `h264`, `audioCodec` `aac` and a non-null `containerFormat` and `bitrate`
- Extracting a thumbnail at 1 second returns bytes that start with the JPEG marker `FF D8`
- Probing a text file raises `MediaProbeError` containing ffprobe's error output
- The policy accepts H.264 MP4 and VP9/Opus WebM, and rejects an `mpeg4`-codec MP4 and a WebM with an `h264` video stream
- A run exceeding the configured timeout is terminated and raises `MediaProcessingError`

---

### SI-03.10 — Video Processor (Metadata, Thumbnail, Ready/Failed Transitions)

**Description:** Consume `process-video` jobs in the worker: extract duration and metadata, generate and store the thumbnail, and drive the `processing → ready | failed` transitions with retry for transient errors and fail-fast for invalid media.

**Technical actions:**

1. Create `src/worker/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 1 })` extending `WorkerHost` (per `library-refs.md` → `@nestjs/bullmq`); `process(job)` follows `### Events/Messages → Processing outcome` steps 1–4: skip when the video is missing or not `processing`; `probe` a presigned GET of `storage_key` signed with the **internal** signer (per `phase-03-videos/TD-06`); reject media outside `isSupportedMedia` (per `phase-03-videos/TD-07`).
2. Generate the thumbnail with `extractThumbnail` at `min(1, durationSeconds / 2)` seconds and `putObject` it at `videos/{id}/thumbnail.jpg` with `image/jpeg` (per `phase-03-videos/TD-01`); persist the metadata columns + `thumbnail_key` and transition `processing → ready` with a conditional update (`WHERE id = :id AND status = 'processing'`) (per `phase-03-videos/TD-10`).
3. Failure handling per `### Events/Messages` step 5 (per `phase-03-videos/TD-10`): `MediaProbeError` or an unsupported format → set `failed` / `UNSUPPORTED_MEDIA` and throw `UnrecoverableError` (no retries, per `library-refs.md` → `bullmq`); any other error → when `job.attemptsMade + 1 >= job.opts.attempts` set `failed` / `PROCESSING_FAILED`, then rethrow so BullMQ retries or records the failure. Both transitions are conditional on `status = 'processing'`.
4. Register in `WorkerModule` only: `TypeOrmModule.forFeature([Video])`, `StorageModule`, `MediaModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` and the `VideoProcessor` provider — never in `AppModule` (per `phase-03-videos/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor.process` | Unit (mock repository/storage/media): skips non-`processing` videos; unsupported media → `failed`/`UNSUPPORTED_MEDIA` + `UnrecoverableError`; transient error on a non-final attempt → rethrown with status unchanged; on the final attempt → `failed`/`PROCESSING_FAILED` | `src/worker/video.processor.spec.ts` |
| `VideoProcessor.process` | Integration (real DB + MinIO + FFmpeg, runs in `video-worker`): a generated MP4 stored at `storage_key` with the video `processing` → `ready` with metadata and a JPEG at `videos/{id}/thumbnail.jpg`; an `mpeg4` MP4 → `failed`/`UNSUPPORTED_MEDIA`; a second run on a `ready` video changes nothing | `src/worker/video.processor.integration-spec.ts` |

**Dependencies:** SI-03.9 — `FfmpegService` and format policy; SI-03.8 — `WorkerModule`; SI-03.2 — `StorageService`; SI-03.4 — queue constants and job contract

**Acceptance criteria:**

- Processing a `process-video` job for a `processing` video holding a valid H.264/AAC MP4 sets `status = 'ready'` and fills `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container_format`, `bitrate` and `thumbnail_key`
- After a successful run, `videos/{id}/thumbnail.jpg` exists in the bucket with content type `image/jpeg`
- A job for a video whose file has an unsupported codec ends with `status = 'failed'`, `failure_reason = 'UNSUPPORTED_MEDIA'`, and the job is not retried (`attemptsMade` = 1)
- A job whose transient error persists across all 3 attempts ends with `status = 'failed'` and `failure_reason = 'PROCESSING_FAILED'`; before the last attempt the status stays `processing`
- Re-delivering a job for a video already `ready` or `failed` leaves the row unchanged
- With the stack running, completing an upload through the API leads the running `video-worker` to set the video `ready` without manual intervention

---

### SI-03.11 — Endpoints for Video Status, Streaming, and Download

**Route:** GET /videos/:publicId, GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** _pending /plan-test-specs_
**Authorization:** Owner only; stream/download only for `ready` videos (per `### Authorization Matrix`)

**Description:** Expose the video's status and metadata for polling, and hand out short-lived presigned URLs so playback (HTTP Range / `206`) and download are served by storage, never by the API.

**Technical actions:**

1. Add `getOwnedVideo(userId, publicId)` to `VideosService` and a response mapper `src/videos/dto/video-response.dto.ts` with the fields of `### API Contracts → GET /videos/:publicId`; `thumbnail_url` is a presigned GET (signing client, `S3_DOWNLOAD_URL_TTL_SECONDS`) when `thumbnail_key` is set, otherwise `null` (per `phase-03-videos/TD-08`).
2. Add `getStreamUrl(userId, publicId)` and `getDownloadUrl(userId, publicId)` — owner check, `status != 'ready'` → `VideoNotReadyException` (owner-only and ready-only per `phase-03-videos/TD-08` revision, AMB-1); presign `GetObject` of `storage_key` with the signing client and `S3_DOWNLOAD_URL_TTL_SECONDS`; the download variant passes `downloadFileName = original_file_name` (quotes escaped) for `ResponseContentDisposition: attachment` (per `phase-03-videos/TD-08`).
3. Add the three routes to `VideosController` — `GET /videos/:publicId` → `200` JSON; `/stream` and `/download` → `302` with the presigned URL in `Location` (Nest `@Redirect()`) — documented with Swagger decorators per `### API Contracts`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` (read/stream/download) | Unit (mock repositories/storage): non-owner → `VideoNotFoundException`; non-`ready` → `VideoNotReadyException`; `thumbnail_url` null without `thumbnail_key`; download passes the escaped original file name | `src/videos/videos.service.spec.ts` |
| `VideosService` (stream/download URLs) | Integration (real DB + MinIO): for a `ready` video with an object at `storage_key`, the stream URL answers a `Range: bytes=0-1023` request with `206` and 1024 bytes; the download URL answers with `Content-Disposition: attachment; filename="<original_file_name>"` | `src/videos/videos.service.integration-spec.ts` |

_Test setup note (applies to these suites and to the E2E spec authored by `/plan-test-specs` for this SI):_ `ready` videos are seeded directly — the row is saved through the `Video` repository with `status = 'ready'` and a few KiB of arbitrary bytes are written at its `storage_key` with `StorageService.putObject`. No worker, queue or FFmpeg is involved: Range/`206` and `Content-Disposition` do not depend on valid media, and the E2E suites run in `nestjs-api`, which has no FFmpeg.

**Dependencies:** SI-03.5 — `VideosService`/`VideosController`; SI-03.2 — presigned GET support

**Acceptance criteria:**

- `GET /videos/:publicId` by the owner returns `200` with `status`, the metadata fields and `thumbnail_url` (`null` while not `ready`)
- `GET /videos/:publicId/stream` on the owner's `ready` video returns `302` whose `Location`, requested with `Range: bytes=0-1023`, responds `206 Partial Content` with 1024 bytes
- `GET /videos/:publicId/download` on a `ready` video returns `302` whose `Location` responds with `Content-Disposition: attachment; filename="<original_file_name>"`
- `GET /videos/:publicId/stream` or `/download` on a `draft`, `processing` or `failed` video returns `409` with `error: "VIDEO_NOT_READY"`
- Any of the three routes called by another authenticated user returns `404` with `error: "VIDEO_NOT_FOUND"`; without a token they return `401`

---

### SI-03.12 — OpenAPI Artifact and AI Documentation for Videos

**Description:** Regenerate the committed OpenAPI artifact with the new video endpoints and update the AI documentation (`CLAUDE.md` files) so it reflects the real state of the code after this phase.

**Technical actions:**

1. Regenerate `nestjs-project/openapi.json` with `npm run openapi:export` (per `openapi-docs-nestjs/TD-02`) so it contains the eight `/videos` operations under the `videos` tag, each with its success schema and `ApiErrorEnvelope` error responses (per `openapi-docs-nestjs/TD-01` revision).
2. Update `nestjs-project/CLAUDE.md` with a **Videos** section describing what exists in code: the `videos`, `storage`, `media` and `worker` modules; the eight endpoints and the upload → complete → process → stream/download flow; the `video-processing` queue and `process-video` job; the new Compose services (`minio`, `minio-init`, `redis`, `video-worker`) and their readiness checks; the new env keys (including why `S3_PUBLIC_ENDPOINT` is the only host-facing value); that FFmpeg-dependent tests run inside `video-worker` (the API image has no FFmpeg); and the test-isolation caveats — tests share the development database with the running API and worker, so `cleanAllTables` also wipes development data, while queue isolation comes from `QUEUE_PREFIX=test` (the running worker only consumes the default prefix); and that the video endpoints are exempt from the auth rate limit (`@SkipThrottle()`).
3. Update the root `CLAUDE.md` § Architecture so the Message Queue and Object Storage entries name the chosen technologies (BullMQ + Redis; MinIO via `pgsty/silo`, S3 API) instead of "TBD"/"S3/MinIO".

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| OpenAPI export | Integration: exported document contains the `/videos` paths with `bearer` security and error-envelope responses | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.7, SI-03.10, SI-03.11 — all endpoints, the worker and the queue must exist before documenting them

**Acceptance criteria:**

- `nestjs-project/openapi.json` lists `POST /videos`, `POST`/`GET /videos/{publicId}/upload/parts`, `POST /videos/{publicId}/upload/complete`, `DELETE /videos/{publicId}/upload`, `GET /videos/{publicId}`, `/stream` and `/download`, each declaring `401` and `404`/`409`/`422` responses with the error envelope schema where applicable
- With `SWAGGER_ENABLED=true`, `GET /api/docs` shows a `videos` tag with those operations
- Every file, service name, env key, endpoint and command mentioned in the new `CLAUDE.md` content exists in the repository (no reference to a non-existent artifact)
- The root `CLAUDE.md` no longer describes the Message Queue as "TBD"

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal identifier; never exposed in API paths |
| public_id | varchar(11) | unique, not null | Short public URL identifier — 11-char base64url from `crypto.randomBytes(8)`; collision → regenerate (bounded retries) *(per phase-03-videos/TD-09)* |
| channel_id | uuid | FK → channels.id, not null | Owner channel (ENUNCIADO § Persistência) |
| title | varchar(100) | not null | Required at create *(per phase-03-videos/TD-03 revision, AMB-2)*; editable in Phase 04 |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | Processing-pipeline lifecycle *(per phase-03-videos/TD-10)*; `draft` = pre-registered, upload not completed *(TD-10 revision, AMB-4)* |
| failure_reason | varchar(64) | nullable | Set only when `status = 'failed'`; one of the values in Error Catalog → *Video failure reasons* |
| original_file_name | varchar(255) | not null | As declared at create *(TD-03 revision, AMB-2)*; used as download filename |
| mime_type | varchar(32) | not null, values: `'video/mp4'`, `'video/webm'` | Declared at create; accepted set per *phase-03-videos/TD-07* / *TD-11* |
| declared_size | bigint | not null | Bytes, declared at create (≤ 10 GiB) *(per phase-03-videos/TD-11)* |
| file_size | bigint | nullable | Actual bytes of the assembled object (`HeadObject` at complete) *(per phase-03-videos/TD-11; TD-06 revision, AMB-3)* |
| storage_key | varchar(255) | not null | `videos/{id}/original.{mp4\|webm}` *(per phase-03-videos/TD-01)* |
| thumbnail_key | varchar(255) | nullable | `videos/{id}/thumbnail.jpg`, set by the worker *(per phase-03-videos/TD-01)* |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` while the upload is open; cleared after complete/abort *(per phase-03-videos/TD-03)* |
| duration_seconds | double precision | nullable | From ffprobe `format.duration` *(TD-06 revision, AMB-3)* |
| width | integer | nullable | From the video stream *(TD-06 revision, AMB-3)* |
| height | integer | nullable | From the video stream *(TD-06 revision, AMB-3)* |
| video_codec | varchar(32) | nullable | e.g. `h264`, `vp9`, `av1` *(TD-06 revision, AMB-3)* |
| audio_codec | varchar(32) | nullable | e.g. `aac`, `opus`; null when the file has no audio stream *(TD-06 revision, AMB-3)* |
| container_format | varchar(64) | nullable | ffprobe `format.format_name` *(TD-06 revision, AMB-3)* |
| bitrate | integer | nullable | bits/s, ffprobe `format.bit_rate` *(TD-06 revision, AMB-3)* |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`, owning side; the inverse `Channel.videos` is not added in this phase)
**Indexes:** `(public_id)` — unique, `(channel_id)` — FK lookup
**Notes:** `bigint` columns are returned by the `pg` driver as strings — map them explicitly to `number` in the entity (TypeORM `transformer`) since all values are ≤ 10 GiB (well within `Number.MAX_SAFE_INTEGER`). Metadata columns stay `null` until the worker sets `status = 'ready'`. Publication/visibility columns are NOT part of this phase — Phase 04 adds them as separate fields without migrating `status` *(TD-10 revision, AMB-4)*.

#### Object storage layout

Single private bucket (name from `S3_BUCKET`) *(per phase-03-videos/TD-01, TD-08)*:

| Key | Written by | Content |
|-----|-----------|---------|
| `videos/{id}/original.mp4` or `videos/{id}/original.webm` | Client, via presigned multipart parts *(TD-03)* | The uploaded file, unchanged *(TD-07)* |
| `videos/{id}/thumbnail.jpg` | Worker *(TD-05, TD-06)* | One JPEG frame |

`{id}` is the internal `videos.id` (immutable PK), never user input *(per phase-03-videos/TD-01)*.

### API Contracts

All endpoints below are authenticated (`Authorization: Bearer <access_token>`, global JWT guard from Phase 02) and owner-scoped (see Authorization Matrix). `:publicId` is `videos.public_id` *(per phase-03-videos/TD-09)*. Error bodies follow the inherited envelope `{ statusCode, error, message }` *(per phase-02-auth/TD-07)*. Video bytes never transit these endpoints: upload parts go client → storage and playback/download go storage → client via presigned URLs *(per phase-03-videos/TD-03, TD-08)*. The video endpoints are exempt from the Phase 02 auth rate limit (`@SkipThrottle()` on the controller): the `ThrottlerGuard` registered as `APP_GUARD` in `AuthModule` applies application-wide (10 requests/60 s), which would reject multi-round part signing and status polling with `429`, while `phase-02-auth/TD-08` intends the limit for the auth surface.

#### POST /videos (SI-03.5)

Pre-registers the video as `draft` and opens the S3 multipart upload *(per phase-03-videos/TD-03; payload per TD-03 revision, AMB-2)*.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — 1 to 100 characters, trimmed
- file_name: string, required — 1 to 255 characters (original file name)
- file_size: integer, required — 1 to 10737418240 (10 GiB) bytes *(per phase-03-videos/TD-11)*
- mime_type: string, required — one of `video/mp4`, `video/webm` *(per phase-03-videos/TD-07, TD-11)*

**Response 201:**
- id: string (the 11-char `public_id`)
- title: string
- status: `"draft"`
- part_size: integer — bytes per part, from `VIDEO_UPLOAD_PART_SIZE_BYTES` (default 104857600 = 100 MiB; minimum 5 MiB); every part except the last must have exactly this size
- part_count: integer — `ceil(file_size / part_size)` (103 for a 10 GiB file at the default part size; S3 limit is 10,000 parts)

**Error responses:**
- 400 VALIDATION_ERROR: when the body fails validation (missing field, `file_size` > 10 GiB, unsupported `mime_type`)
- 401: when the access token is missing or invalid

---

#### POST /videos/:publicId/upload/parts (SI-03.6)

Issues presigned `UploadPart` URLs for the requested part numbers, signed for the client-reachable storage endpoint *(per phase-03-videos/TD-02, TD-03)*.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 to 100 items, each 1 to `part_count`, unique

**Response 200:**
- parts: array of `{ part_number: integer, url: string }` — the client sends `PUT <url>` with the raw part bytes and keeps the `ETag` response header of each part
- expires_in: integer — URL lifetime in seconds (`S3_UPLOAD_URL_TTL_SECONDS`)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 409 VIDEO_NOT_UPLOADABLE: when the video is not `draft` or has no open multipart upload
- 400 VALIDATION_ERROR: when `part_numbers` is missing, empty, too long, or contains a value outside `1..part_count`
- 401: when the access token is missing or invalid

---

#### GET /videos/:publicId/upload/parts (SI-03.6)

Lists the parts already stored for the open multipart upload — used to resume after a connection failure *(per phase-03-videos/TD-03)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- parts: array of `{ part_number: integer, etag: string, size: integer }`, ascending by `part_number`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 409 VIDEO_NOT_UPLOADABLE: when the video is not `draft` or has no open multipart upload
- 401: when the access token is missing or invalid

---

#### POST /videos/:publicId/upload/complete (SI-03.7)

Completes the multipart upload, verifies the actual size, moves the video to `processing` and enqueues the processing job *(per phase-03-videos/TD-03, TD-04, TD-10, TD-11)*. Parts are sorted ascending and de-duplicated by `part_number` before `CompleteMultipartUpload` *(per phase-03-videos/TD-12 — `InvalidPartOrder`)*. Retrying after a partial failure is safe: when `upload_id` is already cleared the S3 completion step is skipped.

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required — 1 to 10000 items of `{ part_number: integer (1–10000), etag: string (non-empty) }`

**Response 202:**
- id: string (`public_id`)
- status: `"processing"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 409 VIDEO_NOT_UPLOADABLE: when the video is not `draft`
- 422 INVALID_UPLOAD_PARTS: when storage rejects the completion (missing/invalid part, wrong ETag, part smaller than 5 MiB other than the last)
- 422 UPLOAD_SIZE_EXCEEDED: when the assembled object is larger than `VIDEO_MAX_UPLOAD_BYTES` (default 10737418240 = 10 GiB; never configurable above that) — the object is deleted and the video is marked `failed` *(per phase-03-videos/TD-11)*
- 400 VALIDATION_ERROR: when `parts` is missing, empty or malformed
- 401: when the access token is missing or invalid

---

#### DELETE /videos/:publicId/upload (SI-03.6)

Cancels an open upload: aborts the multipart upload in storage and deletes the `draft` video row *(per phase-03-videos/TD-03)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** No content.

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 409 VIDEO_NOT_UPLOADABLE: when the video is not `draft`
- 401: when the access token is missing or invalid

---

#### GET /videos/:publicId (SI-03.11)

Returns the video's status and metadata — the client polls it after completing the upload to observe `processing → ready | failed` *(per phase-03-videos/TD-10)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (`public_id`)
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- failure_reason: string | null
- original_file_name: string
- mime_type: string
- file_size: integer | null
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- container_format: string | null
- bitrate: integer | null
- thumbnail_url: string | null — presigned GET of `thumbnail_key` (null until `ready`) *(per phase-03-videos/TD-08)*
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 401: when the access token is missing or invalid

---

#### GET /videos/:publicId/stream (SI-03.11)

Redirects to a presigned `GetObject` URL of the original file; storage serves `Range` requests with `206 Partial Content`, so playback starts without a full download *(per phase-03-videos/TD-07, TD-08)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- `Location` header: presigned GET URL (inline, `S3_DOWNLOAD_URL_TTL_SECONDS` lifetime), signed for the client-reachable storage endpoint

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 409 VIDEO_NOT_READY: when the video status is not `ready`
- 401: when the access token is missing or invalid

---

#### GET /videos/:publicId/download (SI-03.11)

Same as `/stream`, but the presigned URL carries `ResponseContentDisposition: attachment; filename="<original_file_name>"`, so the browser saves the file *(per phase-03-videos/TD-08)*.

**Request headers:**
- Authorization: Bearer <access_token>

**Response 302:**
- `Location` header: presigned GET URL with `response-content-disposition=attachment`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video with `:publicId` exists or the caller does not own it
- 409 VIDEO_NOT_READY: when the video status is not `ready`
- 401: when the access token is missing or invalid

#### Validation Rules — Videos

| Field | Rule | Source |
|-------|------|--------|
| title | string, trimmed, 1–100 characters | TD-03 revision (AMB-2) |
| file_name | string, 1–255 characters | TD-03 revision (AMB-2) |
| file_size | integer, 1 ≤ value ≤ 10737418240 | TD-11 |
| mime_type | `IsIn(['video/mp4', 'video/webm'])` | TD-07, TD-11 |
| part_numbers | array, 1–100 unique integers in `1..part_count` (upper bound checked in the service) | TD-03 |
| parts | array, 1–10000 items; `part_number` integer 1–10000; `etag` non-empty string | TD-03, TD-12 |

### Authorization Matrix

Ownership = the video's `channel_id` is the channel of the authenticated user (`channels.user_id = JWT sub`). A non-owner receives `404 VIDEO_NOT_FOUND` (same as a missing video) so the existence of other channels' videos is not revealed. Phase 03 access is owner-only for every endpoint, including stream/download *(per phase-03-videos/TD-08 revision, AMB-1)*; Phase 04 (visibility) and Phase 05 (anonymous access) extend this.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos | ✗ (401) | ✓ | — | Creates a video owned by the caller's channel |
| POST /videos/:publicId/upload/parts | ✗ (401) | ✗ (404) | ✓ | Only while `draft` with an open upload |
| GET /videos/:publicId/upload/parts | ✗ (401) | ✗ (404) | ✓ | Only while `draft` with an open upload |
| POST /videos/:publicId/upload/complete | ✗ (401) | ✗ (404) | ✓ | Only while `draft` |
| DELETE /videos/:publicId/upload | ✗ (401) | ✗ (404) | ✓ | Only while `draft` |
| GET /videos/:publicId | ✗ (401) | ✗ (404) | ✓ | Any status |
| GET /videos/:publicId/stream | ✗ (401) | ✗ (404) | ✓ | Only `ready` *(TD-08 revision, AMB-1)* |
| GET /videos/:publicId/download | ✗ (401) | ✗ (404) | ✓ | Only `ready` *(TD-08 revision, AMB-1)* |

Presigned URLs themselves carry no JWT: possession of an unexpired URL grants access to that one object until it expires *(per phase-03-videos/TD-08)*.

### Error Catalog

**Error response format:** inherited from Phase 02 — `{ statusCode: number, error: string, message: string | string[] }`, produced by `DomainExceptionFilter` / `ValidationExceptionFilter` *(per phase-02-auth/TD-07)*. New codes are `DomainException` subclasses in `src/common/exceptions/domain.exception.ts`; services throw them, never NestJS HTTP exceptions.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:publicId…` endpoint when the `public_id` does not exist or the video belongs to another channel |
| VIDEO_NOT_UPLOADABLE | 409 | Video is not accepting uploads | Upload endpoints (`upload/parts`, `upload/complete`, `DELETE upload`) when `status != 'draft'`, or `upload/parts` when `upload_id` is null |
| INVALID_UPLOAD_PARTS | 422 | Upload parts are invalid or incomplete | `POST …/upload/complete` when storage rejects `CompleteMultipartUpload` (`InvalidPart`, `InvalidPartOrder`, `EntityTooSmall`, `NoSuchUpload`) |
| UPLOAD_SIZE_EXCEEDED | 422 | Uploaded file exceeds the maximum upload size | `POST …/upload/complete` when `HeadObject.ContentLength > VIDEO_MAX_UPLOAD_BYTES` (default 10737418240) *(per phase-03-videos/TD-11)* |
| VIDEO_NOT_READY | 409 | Video is not ready | `GET …/stream` or `GET …/download` when `status != 'ready'` |
| VALIDATION_ERROR | 400 | (array of field errors) | Inherited — any request body/param failing `ValidationPipe`; also thrown by the service (`InvalidPartNumbersException`, same code) when a `part_numbers` value exceeds the video's `part_count` |

**Video failure reasons** (`videos.failure_reason`, set together with `status = 'failed'` — persisted, not HTTP errors) *(per phase-03-videos/TD-10)*:

| failure_reason | Set by | Trigger |
|----------------|--------|---------|
| UPLOAD_SIZE_EXCEEDED | API (complete) | Assembled object larger than `VIDEO_MAX_UPLOAD_BYTES` (default 10 GiB) *(TD-11)* |
| UNSUPPORTED_MEDIA | Worker | ffprobe fails to read the file, or container/codecs are outside the accepted set (MP4 = H.264 video + AAC audio; WebM = VP8/VP9/AV1 video + Vorbis/Opus audio; audio stream optional) *(TD-07)* — non-retriable (`UnrecoverableError`) |
| PROCESSING_FAILED | Worker | Transient error (storage, DB, FFmpeg timeout) persisted after the last retry attempt *(TD-10)* |

### Events/Messages

#### video-processing → process-video

**Queue:** `video-processing` (BullMQ on Redis) *(per phase-03-videos/TD-04)*
**Job name:** `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

`videoId` is the internal `videos.id` (not the `public_id`). The worker reloads the row; the payload carries no other state.

**Job options:** `jobId = videoId` (BullMQ de-duplicates a second enqueue of the same video while the job exists); `attempts: 3`; `backoff: { type: 'exponential', delay: 5000 }`; `removeOnComplete: true`; `removeOnFail: false` (failed jobs kept for inspection) *(per phase-03-videos/TD-04, TD-10)*

**Producer:** `VideosService` via the injected `video-processing` queue, in `POST /videos/:publicId/upload/complete` after the video is moved `draft → processing` (SI-03.7). If enqueueing fails, the status change is reverted to `draft` so the client can retry `complete` *(per phase-03-videos/TD-04 — enqueue is not atomic with the DB update)*.
**Consumer:** `VideoProcessor` (`@Processor('video-processing')` extending `WorkerHost`) running only in the separate `video-worker` process/container (SI-03.10) *(per phase-03-videos/TD-05)*; worker `concurrency: 1` (FFmpeg is CPU-bound).
**Trigger:** successful completion of the multipart upload with a size within limits.
**Processing outcome (no outbound event):**
1. Load the video; if `status != 'processing'`, finish without changes (idempotent re-delivery).
2. ffprobe the original via a presigned GET signed for the **internal** endpoint *(per phase-03-videos/TD-06)*; reject unsupported media with `UnrecoverableError` *(per phase-03-videos/TD-07, TD-10)*.
3. Extract one frame at `min(1s, duration/2)` to JPEG and `PutObject` it at `videos/{id}/thumbnail.jpg`.
4. Persist metadata + `thumbnail_key` and transition `processing → ready` with a conditional update (`WHERE status = 'processing'`).
5. On failure: if the error is non-retriable or this was the last attempt (`job.attemptsMade + 1 >= attempts`), transition `processing → failed` (conditional) with `failure_reason` `UNSUPPORTED_MEDIA` or `PROCESSING_FAILED`, then rethrow so BullMQ records the failure.

**Delivery semantics:** at-least-once (BullMQ); the consumer is idempotent through the conditional status transitions *(per phase-03-videos/TD-10)*.

---

## Dependency Map

```
SI-03.1 (root — Compose services, libraries, config namespaces)
├── SI-03.2 — depends on SI-03.1 (libraries, storage config and bucket)
├── SI-03.4 — depends on SI-03.1 + SI-03.2 + SI-03.3 (Redis/queue config, StorageModule, Video entity)
│   ├── SI-03.5 — depends on SI-03.4 + SI-03.2 + SI-03.3 (VideosModule, StorageService, entity + public ID)
│   │   ├── SI-03.6 — depends on SI-03.5 (VideosService/controller, draft creation)
│   │   │   └── SI-03.7 — depends on SI-03.6 + SI-03.4 (owner lookup, part signing, producer)
│   │   └── SI-03.11 — depends on SI-03.5 + SI-03.2 (VideosService/controller, presigned GET)
│   └── SI-03.8 — depends on SI-03.1 + SI-03.4 (Redis/MinIO bootstrap, Bull root options to extract)
│       └── SI-03.9 — depends on SI-03.8 (video-worker image with FFmpeg)
│           └── SI-03.10 — depends on SI-03.9 + SI-03.8 + SI-03.2 + SI-03.4 (FfmpegService, WorkerModule, StorageService, job contract)
└── (SI-03.12 — depends on SI-03.7 + SI-03.10 + SI-03.11: documents the finished endpoints, queue and worker)
SI-03.3 (root, independent — Video entity, migration, public ID generator)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Storage and Queue Services, Dependencies, and Configuration Namespaces
- [ ] SI-03.2 — Storage Module (S3 Clients, Multipart and Presigned Operations)
- [ ] SI-03.3 — Video Entity, CreateVideos Migration, and Public ID Generator
- [ ] SI-03.4 — Processing Queue Registration, Producer, and VideosModule
- [ ] SI-03.5 — Endpoint POST /videos (Draft Pre-registration and Upload Initiation)
- [ ] SI-03.6 — Endpoints for Part Signing, Resume Listing, and Upload Cancellation
- [ ] SI-03.7 — Endpoint POST /videos/:publicId/upload/complete (Completion, Size Check, and Enqueue)
- [ ] SI-03.8 — Infra: Video Worker Image, Entrypoint, and Compose Service
- [ ] SI-03.9 — Media Module: Typed ffprobe/ffmpeg Wrapper and Accepted-Format Policy
- [ ] SI-03.10 — Video Processor (Metadata, Thumbnail, Ready/Failed Transitions)
- [ ] SI-03.11 — Endpoints for Video Status, Streaming, and Download
- [ ] SI-03.12 — OpenAPI Artifact and AI Documentation for Videos

**Full test suites:**

- [ ] Infrastructure up and ready (`cd nestjs-project && docker compose up -d && docker compose ps` — `minio`, `redis`, `db` healthy; `minio-init` exited 0; `nestjs-api` and `video-worker` running)
- [ ] Backend unit + integration tests pass (`cd nestjs-project && docker compose exec video-worker npm test -- --runInBand`) — run in `video-worker` because the FFmpeg-dependent suites need its binaries; it shares the code, `.env` and Compose network with `nestjs-api`
- [ ] Backend E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
