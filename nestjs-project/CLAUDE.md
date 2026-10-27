# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **MinIO:** `curl -f http://localhost:9000/minio/health/live` — expect HTTP 200 (and `docker compose ps -a` must show `minio-init` as `Exited (0)`: it creates the bucket)

`docker compose up -d` also starts `video-worker`, the queue consumer (a long-running Node process, not the HTTP server), so the "do not start the NestJS server" rule still holds for `nestjs-api`.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture, SMTP `1025`, web UI `8025`
- `minio` — S3-compatible object storage (`pgsty/silo`, pinned tag), S3 API `9000`, console `9001`
- `minio-init` — one-shot job that creates the bucket (`S3_BUCKET`) before the API and worker depend on it
- `redis` — queue backend (`redis:7.4-alpine`), internal only
- `video-worker` — video processing worker, built from `Dockerfile.worker.dev` (includes FFmpeg)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

Where each suite runs:

```bash
# Unit + integration: in nestjs-api or video-worker (both images include FFmpeg, which the media specs need)
docker compose exec nestjs-api npm test -- --runInBand --forceExit

# E2E: in nestjs-api
docker compose exec nestjs-api npm run test:e2e
```

`--forceExit` is required in this environment: without it Jest keeps open handles (Redis/S3 clients) and never exits.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## Videos (Phase 03)

Upload, processing, streaming and download of videos. Video bytes never pass through the API: the client sends the file straight to object storage and receives it straight back through presigned URLs.

### Modules

- `src/videos/` — `VideosModule`: `Video` entity (`videos` table, owned by a `Channel`), `VideosService`, `VideosController`, `VideoProcessingProducer`, DTOs, constants and the public-id generator (`public-id.util.ts`).
- `src/storage/` — `StorageModule`/`StorageService`: the only code that talks to the S3 SDK (multipart lifecycle, presigned part and GET URLs, object I/O). Two clients: one for the in-network endpoint (`S3_ENDPOINT`) and one used only to sign URLs (`S3_PUBLIC_ENDPOINT`).
- `src/media/` — `MediaModule`/`FfmpegService`: typed wrapper over the system `ffprobe`/`ffmpeg` binaries (metadata, JPEG frame, timeout) and `isSupportedMedia` (accepted codec combinations).
- `src/worker/` — `WorkerModule` and `VideoProcessor`, the queue consumer. Entrypoint: `src/worker.ts` (standalone Nest context, no HTTP). The processor is registered only here, never in `AppModule`.
- Shared bootstrap options used by both processes: `src/config/config-module.options.ts`, `src/database/typeorm.options.ts`, `src/queue/bull.options.ts`.

### Endpoints

All require the `Authorization: Bearer <access_token>` header and are owner-only (another user's video, or an unknown id, returns `404 VIDEO_NOT_FOUND`). `:publicId` is the 11-character `videos.public_id`.

| Endpoint | Purpose |
|----------|---------|
| `POST /videos` | Pre-registers the video as `draft`, opens the S3 multipart upload, returns `part_size` and `part_count` |
| `POST /videos/:publicId/upload/parts` | Presigned `UploadPart` URLs for the requested part numbers |
| `GET /videos/:publicId/upload/parts` | Parts already stored (resume after a failed connection) |
| `POST /videos/:publicId/upload/complete` | Assembles the upload, checks the real size, moves `draft → processing`, enqueues the job (`202`) |
| `DELETE /videos/:publicId/upload` | Cancels a draft: aborts the multipart upload and deletes the row |
| `GET /videos/:publicId` | Status and metadata (poll it while `processing`) |
| `GET /videos/:publicId/stream` | `302` to a presigned URL of the original; storage answers Range requests with `206` |
| `GET /videos/:publicId/download` | `302` to a presigned URL that forces `Content-Disposition: attachment` |

### Flow

1. `POST /videos` → `draft` + multipart upload. The title is required; file size is capped at 10 GiB and the MIME type must be `video/mp4` or `video/webm`.
2. The client requests part URLs, `PUT`s each part directly to storage and keeps the returned `ETag`s.
3. `POST …/upload/complete` → `processing`, and a `process-video` job (`{ videoId }`) is added to the `video-processing` queue (BullMQ on Redis, `jobId = videoId`, 3 attempts, exponential backoff).
4. `VideoProcessor` (in `video-worker`) probes the stored original, rejects unsupported codecs without retries, stores `videos/{id}/thumbnail.jpg`, fills the metadata columns and moves the video to `ready`.
5. Failures: unsupported/unreadable media → `failed` with `failure_reason = UNSUPPORTED_MEDIA`; other errors are retried and, after the last attempt, `PROCESSING_FAILED`; an oversize upload is rejected at `complete` (`UPLOAD_SIZE_EXCEEDED`). All status changes are conditional (`WHERE status = …`) so re-delivered jobs are harmless.
6. Only `ready` videos can be streamed or downloaded (`409 VIDEO_NOT_READY` otherwise).

Status lifecycle: `draft → processing → ready | failed`. Publication/visibility is not part of this phase.

### Configuration

New keys (all validated in `src/config/env.validation.ts`, documented in `.env.example`):

- Storage: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_UPLOAD_URL_TTL_SECONDS`, `S3_DOWNLOAD_URL_TTL_SECONDS`.
- Queue: `REDIS_HOST`, `REDIS_PORT`, `QUEUE_PREFIX`.
- Videos: `VIDEO_MAX_UPLOAD_BYTES` (never above 10 GiB), `VIDEO_UPLOAD_PART_SIZE_BYTES` (5 MiB–5 GiB), `VIDEO_MEDIA_TIMEOUT_SECONDS`.

`S3_ENDPOINT` uses the Compose service name (`http://minio:9000`) like every other service host. `S3_PUBLIC_ENDPOINT` (`http://localhost:9000`) is the **only host-facing value**: presigned URLs are consumed by clients outside the Compose network and SigV4 signs the host, so they must be signed for an address the client can resolve. It is never used for server-side calls.

### Worker and FFmpeg

- `video-worker` runs `npm run start:worker:dev` (Nest watch build into `dist-worker/`, via `tsconfig.worker.json`); `npm run start:worker` runs the compiled `dist/worker`.
- Both the worker image and the `nestjs-api` dev image install FFmpeg: the specs that need it (`src/media/*.integration-spec.ts`, `src/worker/video.processor.integration-spec.ts`) run in either container. The API runtime itself never calls FFmpeg.
- The worker service sets `TSC_WATCHFILE`/`TSC_WATCHDIRECTORY` to make the TypeScript watcher poll, because file-change events from bind mounts do not reach it on this setup.

### Test isolation caveats

- Tests share the **development database** with the running API and worker: `cleanAllTables` (`src/test/create-test-data-source.ts`) also wipes development data.
- Queue isolation comes from `QUEUE_PREFIX=test`, set by `src/test/setup-test-env.ts` (loaded by both Jest configs). The running worker only consumes the default `bull` prefix, so it never picks up test jobs.
- The same file sets `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (tests run inside the Compose network and must reach the presigned URLs) and small limits (`VIDEO_UPLOAD_PART_SIZE_BYTES` 5 MiB, `VIDEO_MAX_UPLOAD_BYTES` 12 MiB) so multi-part and size-limit paths run with a few MiB.
- Helpers: `src/test/storage.ts` (delete objects by prefix), `src/test/media-fixtures.ts` (generates sample MP4/WebM with FFmpeg), `src/test/e2e-auth.ts` (register, confirm and log in a user).
- E2E specs are derived from `specs/*.plan.md` (`test/videos-*.e2e-spec.ts`). Creating several supertest requests up front and awaiting them later fails with `ECONNREFUSED`; create each request when you send it.
- Specs that drop tables (`src/database/migrations.integration-spec.ts`) must do so sequentially: parallel `DROP TABLE … CASCADE` deadlocks on the foreign keys.

### Rate limiting

`VideosController` is marked `@SkipThrottle()`: the `ThrottlerGuard` registered in `AuthModule` is application-wide (10 requests/minute) and would reject part signing and status polling. E2E suites still clear the throttler storage in `beforeEach` because obtaining a token goes through the throttled auth endpoints.

### OpenAPI

The video endpoints are documented with `@ApiTags('videos')`, `@ApiBearerAuth('access-token')` and `ApiErrorEnvelope` responses. Request DTOs carry explicit `@ApiProperty` because `npm run openapi:export` runs through `ts-node`, where the Swagger CLI plugin does not infer schemas. Regenerate the committed `openapi.json` with `docker compose exec nestjs-api npm run openapi:export` whenever an endpoint or DTO changes.

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
