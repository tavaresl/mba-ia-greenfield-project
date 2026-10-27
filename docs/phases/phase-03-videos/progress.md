# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 6/12 completed

### SI-03.1 — Infra: Storage and Queue Services, Dependencies, and Configuration Namespaces
- **Status:** completed
- **Tests:** 9 passing in `env.validation.integration-spec.ts`; regression 149 unit/integration + 52 e2e passing; `tsc --noEmit` exit 0
- **Observations:**
  - Pre-requisite fix committed before this SI (`507c8c9`): `migrations.integration-spec.ts` did not drop the leftover `verification_tokens_type_enum`, so the baseline was 143/144. Later SIs that add enums must drop them in the same `beforeAll`.
  - Jest must run with `--forceExit` here (open handles keep the process alive); `package.json` scripts were not changed.
  - `npm run lint` already fails on the baseline (150 errors before this SI, mostly `no-unsafe-*` in existing specs); this SI added no new lint errors. Needs a decision before the Definition of Done can pass.
  - `.env.example` has an unquoted `MAIL_FROM` that breaks Docker Compose parsing on a fresh clone (pre-existing, out of scope; local `.env` was quoted).
  - `.env` (gitignored) was extended with the new keys; `S3_ACCESS_KEY`/`S3_SECRET_KEY` defaults in `.env.example` are development-only values.

### SI-03.2 — Storage Module (S3 Clients, Multipart and Presigned Operations)
- **Status:** completed
- **Tests:** 9 passing (8 integration against real MinIO + 1 module compilation); regression 158 unit/integration + 52 e2e passing; `tsc --noEmit` exit 0; lint count unchanged from baseline (150 errors)
- **Observations:**
  - `StorageModule` exports `StorageService` and the internal S3 client token (`S3_INTERNAL_CLIENT`); the signing client stays private to the module. The test cleanup helper `src/test/storage.ts` takes the internal client.
  - Beyond the plan's list, the integration spec also covers `deleteObject` and `listParts` after `abortMultipartUpload` (`NoSuchUpload`), and checks presigned URL origins with a config override (public vs internal endpoint).
  - `ts-jest` did not flag a `Buffer` passed as `fetch` body, but `tsc --noEmit` did (fixed in the spec with `new Uint8Array(body)`); keep running `tsc` after specs.
  - Presigned `UploadPart` PUTs worked against `pgsty/silo` with `requestChecksumCalculation: 'WHEN_REQUIRED'`, as the library-refs caution anticipated.

### SI-03.3 — Video Entity, CreateVideos Migration, and Public ID Generator
- **Status:** completed
- **Tests:** 12 passing in the SI's files (6 entity integration, 2 `generatePublicId` unit, 4 migrations integration); regression 168 unit/integration + 52 e2e passing; `tsc --noEmit` exit 0; lint count unchanged from baseline (150 errors)
- **Observations:**
  - Migration generated with `npm run migration:generate` against the dev DB *before* any test created the `videos` table, so the diff is exact: `1793065595069-CreateVideos.ts` (enum, table, unique `public_id` index, `channel_id` index, FK; `down` in reverse order). Verified via the CLI: `migration:revert` removes the table and `videos_status_enum`, `migration:run` restores them.
  - `migrations.integration-spec.ts` now covers 3 migrations / 5 tables, enum + unique index + FK existence, and reverts `CreateVideos` and `CreateAuthTokens` in separate tests. It drops `videos_status_enum` alongside `verification_tokens_type_enum` (as anticipated in SI-03.1 observations).
  - Flaky deadlock fixed: the spec's `beforeAll` ran the `DROP TABLE ... CASCADE` statements in parallel (`Promise.all`) on different pool connections; with the new `videos -> channels` FK this deadlocked intermittently (1 of ~4 full runs), and the failed `afterAll` cascaded into ~30 failures in other suites. Drops are now sequential; 12 consecutive runs of the affected suites and 2 full runs passed afterwards.
  - `cleanAllTables` deletes from `videos` first (FK order).
  - Pre-existing lint error `no-unsafe-function-type` in `src/test/create-test-data-source.ts` left untouched (baseline debt).

### SI-03.4 — Processing Queue Registration, Producer, and VideosModule
- **Status:** completed
- **Tests:** 4 passing in the SI's files (3 producer integration against real Redis + 1 module compilation); regression 172 unit/integration + 52 e2e passing (2 consecutive full runs); `tsc --noEmit` exit 0; lint count unchanged from baseline (150 errors)
- **Observations:**
  - **Undocumented dependency:** `bullmq@6` no longer bundles `ioredis` (optional peer, `>=5`); without it, queue creation fails with "BullMQ could not load the optional 'ioredis' package". Installed `ioredis@^5.11.1` (the registry `latest` is 6.0.0, which neither the plan nor `@nestjs/bullmq@11` was validated against). `library-refs.md` does not mention this; the worker (SI-03.8/03.10) reuses the same install.
  - The `BullModule.forRootAsync` options currently live inline in `AppModule` and are repeated in the two specs; SI-03.8 extracts them into a shared `bull.options.ts` per the plan.
  - Producer applies the job options explicitly on each `add` (`PROCESS_VIDEO_JOB_OPTIONS` + `jobId = videoId`) instead of `defaultJobOptions` on the queue, so the contract is visible at the call site and asserted by the integration spec.
  - `removeOnComplete: true` means de-duplication by `jobId` only holds while the job exists; a re-enqueue after completion creates a new job (the processor must stay idempotent, as planned in TD-10).
  - Test isolation: `QUEUE_PREFIX=test` is applied by `setup-test-env.ts`; the spec obliterates its queue before each test. A `test:video-processing:meta` key remains in Redis after e2e runs (harmless).

### SI-03.5 — Endpoint POST /videos (Draft Pre-registration and Upload Initiation)
- **Status:** completed
- **Tests:** 12 passing in the SI's files (5 `VideosService` unit, 2 `VideosService` integration, 7 e2e from `videos-create.plan.md`); regression 179 unit/integration + 59 e2e passing (2 consecutive full runs of each); `tsc --noEmit` exit 0; lint count unchanged from baseline (150 errors)
- **Observations:**
  - All six Phase 03 domain exceptions from the Error Catalog were added now (only `VALIDATION_ERROR`-style input errors are used by this SI); later SIs consume the rest.
  - Added `src/videos/videos.constants.ts` (MIME types, extensions, 10 GiB DTO limit, 100/255 length limits, 5 public-id attempts) and `src/common/database/pg-errors.ts` (`isPgUniqueViolationOnColumn`). `ChannelsService` still has its own private copy of that helper; deduplicating it is a refactor outside this SI (follow-up).
  - Shared e2e helper `src/test/e2e-auth.ts` (`registerConfirmAndLogin`) mirrors the helper inside `auth.e2e-spec.ts` so the next video e2e specs do not repeat it; `auth.e2e-spec.ts` was left untouched.
  - The DTO limit (10 GiB) is fixed in the contract; `VIDEO_MAX_UPLOAD_BYTES` can only lower the enforced limit at `complete` (SI-03.7). With the test env (5 MiB parts) the e2e asserts `part_count = ceil(file_size / part_size)` for 10 GiB; the exact 103 at the default 100 MiB part size is asserted in the unit spec, which injects production defaults instead of the test env values.
  - The Swagger CLI plugin picks up `*.dto.ts`; the new `CreateVideoResponseDto` lives in `dto/create-video-response.dto.ts` for that reason. `src/metadata.ts` / `openapi.json` are regenerated in SI-03.12.
  - e2e `afterEach` aborts open multipart uploads and removes `videos/` objects so MinIO does not accumulate parts across runs.

### SI-03.6 — Endpoints for Part Signing, Resume Listing, and Upload Cancellation
- **Status:** completed
- **Tests:** 20 passing in the SI's files (10 `VideosService` unit incl. ownership/sign/list/cancel, 4 integration, 6 e2e from `videos-upload-parts.plan.md`); regression 193 unit/integration + 65 e2e passing (2 consecutive full runs of each); `tsc --noEmit` exit 0; lint count unchanged from baseline (150 errors)
- **Observations:**
  - `part_count` is not persisted: it is derived from `declared_size` and the *current* `VIDEO_UPLOAD_PART_SIZE_BYTES` each time parts are signed. Changing that env var while an upload is in flight would shift the allowed range; acceptable for this phase, but persisting the part size on the row would remove the coupling if it ever matters.
  - Ownership is a single query (`public_id` + `channel.user_id`), so a stranger's video and a non-existent id are indistinguishable (`404 VIDEO_NOT_FOUND`). Check order is 404 → 409 (`VIDEO_NOT_UPLOADABLE`) → 400 (part number above `part_count`).
  - supertest pitfall in the e2e spec: building several requests up front and awaiting them later fails with `ECONNREFUSED` (the first completed request closes the shared ephemeral server). The spec creates each request lazily; worth remembering for the next e2e specs.
  - `cancelUpload` propagates storage errors from `abortMultipartUpload` (including `NoSuchUpload`) without deleting the row; a retry after a partial failure is therefore not idempotent for an already-aborted upload. Not covered by the plan; left as is.
  - Response DTOs live in `dto/upload-parts-response.dto.ts` (`*.dto.ts` so the Swagger CLI plugin infers them); `openapi.json` is regenerated in SI-03.12.

### SI-03.7 — Endpoint POST /videos/:publicId/upload/complete (Completion, Size Check, and Enqueue)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.8 — Infra: Video Worker Image, Entrypoint, and Compose Service
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.9 — Media Module: Typed ffprobe/ffmpeg Wrapper and Accepted-Format Policy
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.10 — Video Processor (Metadata, Thumbnail, Ready/Failed Transitions)
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.11 — Endpoints for Video Status, Streaming, and Download
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.12 — OpenAPI Artifact and AI Documentation for Videos
- **Status:** pending
- **Tests:** pending
- **Observations:** none

