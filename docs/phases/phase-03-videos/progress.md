# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/12 completed

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
- **Status:** pending
- **Tests:** pending
- **Observations:** none

### SI-03.6 — Endpoints for Part Signing, Resume Listing, and Upload Cancellation
- **Status:** pending
- **Tests:** pending
- **Observations:** none

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

