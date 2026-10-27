---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-26
scope_description: "Phase 03 (backend) — upload and background processing of videos in nestjs-project: how the S3-compatible object storage (MinIO in dev) is used (bucket/key organization, client library, presigned access), the 10GB upload strategy that keeps bytes off the API, the job queue technology, the video worker topology and FFmpeg/ffprobe integration, the streaming (HTTP Range / 206) and download delivery, the unique short video identifier, and the video status lifecycle including processing-failure handling."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — the only subproject with work in this phase. Owns the new `videos` module (entity linked to `Channel`, migration, upload orchestration, stream/download URL issuance), the storage and queue integrations, the video worker (FFmpeg/ffprobe), and the new Compose services (object storage, queue backend, worker). All TDs below.
- `next-frontend/` — **no open decision in this document.** Per `ENUNCIADO.md` ("Este é um desafio de backend… a interface de vídeo não faz parte do escopo desta fase"), Phase 03 delivers the API, worker, infrastructure and planning artifacts only. The endpoints defined here are consumed by the frontend in later phases through the existing OpenAPI chain (`openapi-docs-nestjs/TD-02`); nothing in this document constrains FE implementation choices.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Object storage is given, not chosen:** S3-compatible API — MinIO locally in Docker, swappable for S3 in production (`ENUNCIADO.md` § "Sobre o object storage"; C4 diagram `docs/diagrams/software-arch.mermaid`). This document decides **how** to use it (bucket/key organization, client, presigned access) and **which container image** provides MinIO in Compose (TD-12), not **which** storage.
> - **Config & env validation:** `phase-01-configuracao-base/TD-01..TD-04` (`@nestjs/config` + Joi + `registerAs` namespaces). New storage/queue keys follow this pattern.
> - **Auth:** global JWT guard with custom `@nestjs/jwt` guards (`phase-02-auth/TD-02`). Upload endpoints are authenticated; the video owner is the authenticated user's channel (1:1, created at signup).
> - **Validation / errors / rate limiting:** class-validator (`phase-02-auth/TD-06`), domain exception filter with `{ statusCode, error, message }` envelope (`phase-02-auth/TD-07`), `@nestjs/throttler` (`phase-02-auth/TD-08`).
> - **OpenAPI:** `@nestjs/swagger` + exported `openapi.json` (`openapi-docs-nestjs/TD-01..TD-02`) — new endpoints are documented through it.
> - **Docker networking:** service-to-service connections use Compose service names, never `localhost` (root `CLAUDE.md`).
> - **Runtime facts that constrain options:** Nest **11.1.16** on Node **25.6** (`nestjs-project/Dockerfile.dev`), compiled as **CommonJS** (`tsconfig.json` → `module: nodenext`, no `"type": "module"`), Jest 30 + ts-jest 29; TypeORM 0.3.28; PostgreSQL 17.

---

## TD-01: Bucket & Object Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API writes upload targets (presigned multipart, TD-03), the worker reads the original and writes the thumbnail (TD-05/TD-06), and stream/download URLs are issued for these keys (TD-08). The bucket bootstrap (bucket creation, CORS for direct client PUTs) also depends on this layout. The keys are persisted in the `videos` table (`ENUNCIADO.md` § Persistência: "chaves de storage do arquivo e do thumbnail"), so the scheme is a contract between API, worker, DB and Compose bootstrap.

**Options:**

### Option A: Single private bucket, per-video prefix keyed by the internal video ID
- `videos/{videoId}/original{.ext}` and `videos/{videoId}/thumbnail.jpg` in one bucket (e.g. `streamtube`).
- **Pros:** One bucket to bootstrap/configure (CORS, policies); all objects of a video share a prefix — deleting or listing a video's assets is one prefix operation; keys derive from the immutable PK, never from user input (no sanitization, no rename problems); maps 1:1 to an S3 bucket in production.
- **Cons:** Videos and thumbnails share bucket-level settings (cannot, for example, make only thumbnails public without a prefix-scoped policy).

### Option B: Two buckets (`videos`, `thumbnails`), key = `{videoId}{.ext}`
- **Pros:** Bucket-level settings can differ per asset type (e.g. public thumbnails, private videos); simple flat keys.
- **Cons:** Two buckets to bootstrap and keep in sync across environments; a video's assets are spread across buckets; per-type settings are not needed by any decision in this phase (TD-08 keeps both private).

### Option C: Single bucket, channel-scoped prefix `channels/{channelId}/videos/{videoId}/…`
- **Pros:** Per-channel storage accounting by prefix; easy bulk removal of a channel's media.
- **Cons:** Keys embed ownership — a future ownership change would require moving objects; longer keys; per-channel accounting is not a Phase 03 requirement.

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/…`)** — the minimum layout that serves both asset types, derives keys from the immutable PK, and needs a single bucket bootstrap in Compose.

**Decision:** A (single private bucket, `videos/{videoId}/…`)

---

## TD-02: S3 Client Library (API + Worker)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API (create/complete multipart, presign part and GET URLs, `HeadObject`) and the worker (read the original for ffprobe/ffmpeg, upload the thumbnail) both call storage. The client must support the multipart lifecycle, presigning of individual commands, custom `endpoint` + `forcePathStyle` (MinIO), and a drop-in switch to AWS S3 in production.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular official SDK (3.x, Node ≥20, CommonJS-compatible). `getSignedUrl(client, new UploadPartCommand(...))` presigns individual parts; `GetObjectCommand` accepts `ResponseContentDisposition` for downloads.
- **Pros:** Canonical S3 API — identical code against MinIO and AWS S3 (production switch is config-only); presigns any command, including `UploadPart`; typed; extensive documentation.
- **Cons:** Verbose command-object API.

### Option B: `minio` (minio-js)
- MinIO's own S3-compatible JS client.
- **Pros:** Compact API (`presignedGetObject`, `fPutObject`).
- **Cons:** No first-class API to presign individual multipart parts (required by TD-03 A); vendor-specific client for an S3-portable design; the vendor archived its Community Edition server in 2026.

**Recommendation:** **Option A (AWS SDK v3)** — the only option that presigns individual multipart parts out of the box and keeps the "MinIO in dev, S3 in prod" switch purely configurational.

**Decision:** A (AWS SDK v3)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Upload Strategy for Files up to 10GB

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** 10GB files must be uploaded without holding the API during the transfer (`ENUNCIADO.md`: "sem segurar a API durante o envio"; passing the file through the API is an automatic rejection criterion) and, per `project-plan.md` § Pontos de Atenção, should be resumable after a connection failure. A single presigned `PUT`/`POST` is not viable: S3 caps a single-request upload at 5GB, so 10GB requires multipart. The strategy also defines where the draft pre-registration happens. **Depends on:** TD-01, TD-02.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (client → storage direct)
- `POST /videos` (authenticated) creates the draft video row and calls `CreateMultipartUpload`; the client requests presigned URLs for its parts, `PUT`s each part **directly to storage**, then calls a complete endpoint (API runs `CompleteMultipartUpload`, moves the video to processing, enqueues the job — TD-04). Resume = list already-uploaded parts (`ListParts`) and send the missing ones; abort endpoint for cancellation.
- **Pros:** Zero video bytes cross the API — it only handles small JSON calls; parts upload in parallel; native resume; the pre-registration hook is explicit at `create`; matches the C4 Frontend → Storage edge for future clients.
- **Cons:** Storage must be reachable by the client: presigned URLs must be signed for a client-reachable host (public endpoint) distinct from the in-network Compose service name, and the bucket needs CORS for browser clients (`PUT`, expose `ETag`). Size/type integrity is verified at complete time (TD-11), not inline.

### Option B: tus resumable protocol terminated in the API (`@tus/server` + `@tus/s3-store`)
- Client speaks tus to a Nest route; the tus server streams chunks into S3 multipart. Pre-registration in the `onUploadCreate` hook.
- **Pros:** Open standard with offset-based resume; storage stays private to the Docker network; inline validation possible.
- **Cons:** **Every byte flows through the API process** — 10GB per upload occupying API sockets, memory buffers and event-loop time, which is what the challenge explicitly forbids; `@tus/server` 2.x is **ESM-only** (`"type": "module"`, Node ≥20.19) inside a CommonJS app — works at runtime via Node 25 `require(esm)`, with Jest/ts-jest interop friction.

**Recommendation:** **Option A (S3 multipart with presigned parts)** — the only option where a 10GB upload puts no load on the API, which is the phase's central non-functional requirement; the public/internal endpoint split and CORS are one-time configuration.

**Decision:** A (S3 multipart upload with presigned part URLs, client → storage)
**Revisions:**
- 2026-10-26 — Pre-registration payload clarified (AMB-2): `POST /videos` requires `title` plus original file name, declared size and MIME type; all are persisted on the draft row. Title stays editable in Phase 04. Rationale: user chose title-required-at-create over deriving it from the file name.

---

## TD-04: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The C4 diagram leaves the Message Queue as **"TBD"** — the main stack decision of this phase (`ENUNCIADO.md`). The API publishes a processing job when an upload completes (TD-03); the worker (TD-05) consumes it. Requirements: retries with backoff and a way to mark a job as non-retriable (TD-10), a concurrency limit (FFmpeg is CPU-heavy), at-least-once delivery, and a real service in Compose that tests can exercise. Version note: `@nestjs/bullmq@12` targets Nest 12 — this project (Nest 11.1) uses `@nestjs/bullmq@11.0.x` (peer `bullmq ^5 || ^6`).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Official Nest integration (`BullModule.forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`); adds a `redis` Compose service.
- **Pros:** First-party Nest 11 module, CommonJS-compatible; per-job `attempts` + exponential `backoff`, `UnrecoverableError` for non-retriable failures, worker `concurrency`, stalled-job recovery, job events; the project's testing guide already anticipates `BullModule.registerQueue()` wiring tests.
- **Cons:** New infrastructure (Redis) to run and keep healthy; enqueue is not atomic with the Postgres transaction that moves the video to processing (a crash between commit and enqueue leaves a video stuck — must be handled in the plan, e.g. enqueue-then-update ordering with idempotent jobs).

### Option B: pg-boss (PostgreSQL)
- Job queue on the existing Postgres using `SKIP LOCKED`.
- **Pros:** No new infrastructure; jobs can be enqueued **in the same transaction** as the status update (no stuck-video window); retries/backoff built in.
- **Cons:** v12 is **ESM-only** and requires Node ≥22.12 (runtime OK via `require(esm)`, Jest/ts-jest friction); **no official Nest module** — DI/lifecycle wrapper must be hand-written; queue polling load shares the primary DB.

### Option C: RabbitMQ (`@nestjs/microservices` RMQ transport)
- **Pros:** Full message broker; routing flexibility; language-agnostic consumers.
- **Cons:** Heaviest infrastructure; the Nest RMQ transport has message semantics, not job semantics — retries with backoff, attempt counting and concurrency per job would be hand-rolled; overkill for a single job type.

**Recommendation:** **Option A (BullMQ + Redis)** — the only option with an official Nest 11 module and job-level retry/backoff/concurrency semantics out of the box; the cost is one Redis container, which the C4 diagram already budgets as a separate "Message Queue" container.

**Decision:** A (BullMQ + Redis)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-05: Video Worker Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram models a separate "Video Worker (FFmpeg)" container that reads/writes storage and updates the DB; `ENUNCIADO.md` requires the worker to come up via Compose with the backend. Where its code lives and how it runs drives Compose layout, image contents (FFmpeg binary), entity sharing and test structure. **Depends on:** TD-04.

**Options:**

### Option A: Separate worker process from the same `nestjs-project` codebase, own Compose service
- Second entrypoint (e.g. `src/worker.ts` → `NestFactory.createApplicationContext(WorkerModule)`) hosting the `@Processor`; Compose service `video-worker` built from an image that adds FFmpeg; the API image stays FFmpeg-free and never registers the processor.
- **Pros:** Matches the C4 container split; FFmpeg CPU load never competes with API request latency; reuses entities, config namespaces, storage service and the existing Jest/integration infra; scales independently.
- **Cons:** Two Nest processes to run in dev; module boundaries must keep processor code out of the API module graph.

### Option B: Processor inside the API process
- `@Processor` registered in `AppModule`; FFmpeg installed in the API image.
- **Pros:** One process, one container — simplest setup.
- **Cons:** FFmpeg saturates the API container's CPU while processing, contradicting "sem impacto na performance"; no separate worker container as the C4 diagram and `ENUNCIADO.md` expect.

### Option C: BullMQ sandboxed processor forked by the API (`registerQueue({ processors: [path] })`)
- **Pros:** Processing runs in a child process, isolating crashes from the API event loop.
- **Cons:** Still inside the API container (shared CPU, FFmpeg in the API image); Nest documents that **DI is unavailable** in sandboxed processors — repositories, config and storage service would be instantiated by hand.

### Option D: Separate subproject (`video-worker/`)
- **Pros:** Strongest isolation; language freedom.
- **Cons:** Duplicates entities/DB access/config/storage client or forces shared-package tooling that does not exist; new lint/test/CLAUDE.md setup — large overhead for one job type.

**Recommendation:** **Option A (separate process, same codebase, own container)** — honors the C4 container boundary and keeps FFmpeg off the API while sharing persistence, config and storage code with full DI.

**Decision:** A (separate worker process, same codebase, own Compose service)

---

## TD-06: FFmpeg / ffprobe Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker needs `ffprobe` (duration, resolution, codecs, bitrate, container) and `ffmpeg` (one frame → thumbnail image). The historical Node wrapper, `fluent-ffmpeg`, is **deprecated on npm ("Package no longer supported")**. The choice covers how the binary is obtained and how it is invoked. **Depends on:** TD-05 (binary lives in the worker image).

**Options:**

### Option A: System FFmpeg (apt, worker image) + thin typed `child_process.spawn` wrapper
- `ffprobe -v error -print_format json -show_format -show_streams <input>` parsed into a typed result; `ffmpeg -ss <t> -i <input> -frames:v 1 …` for the thumbnail. `<input>` can be a presigned GET URL (HTTP Range), avoiding a full local download for probing.
- **Pros:** No deprecated or third-party wrapper; full flag control; distro-maintained binary; JSON output trivially typed; wrapper unit-testable by mocking `spawn`, integration-testable against the real binary in the worker container.
- **Cons:** Own small wrapper (argument building, exit-code/stderr → domain error mapping, timeouts).

### Option B: `fluent-ffmpeg` + system FFmpeg
- **Pros:** Familiar fluent API, many examples.
- **Cons:** Deprecated and unmaintained — immediate debt in a greenfield phase; same binary dependency anyway.

### Option C: `ffmpeg-static` / `@ffprobe-installer` npm binaries + `spawn` wrapper
- **Pros:** Binary version pinned via `package-lock`; no Dockerfile change.
- **Cons:** Platform-specific binary downloaded at `npm install` into a bind-mounted `node_modules` (host/container architecture mismatch risk); third-party build provenance.

**Recommendation:** **Option A (system FFmpeg + typed spawn wrapper)** — avoids a deprecated dependency and binary-provenance issues; the worker image (TD-05 A) is the natural place to install FFmpeg.

**Decision:** A (system FFmpeg + typed `spawn` wrapper)
**Revisions:**
- 2026-10-26 — Persisted metadata clarified (AMB-3): typed columns for duration, width, height, video codec, audio codec, container format, bitrate and size (bytes), extracted from ffprobe. Rationale: queryable, testable Data Model over a free-form JSON column.

---

## TD-07: Processing Output & Streaming Format

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** "Streaming without full download" can be met by progressive HTTP Range requests (`206 Partial Content`) on a playable file, or by segmented adaptive streaming (HLS). The choice fixes what the worker produces, which input formats are accepted, and how much storage each video consumes (`project-plan.md` § Pontos de Atenção: storage growth and cost).

**Options:**

### Option A: Keep the original file; accept web-playable formats; progressive streaming via HTTP Range
- Accept MP4 (H.264/AAC) and WebM (VP8/VP9/AV1 + Vorbis/Opus). The worker runs ffprobe for duration/metadata and generates the thumbnail; if the streams are not in the accepted set, the video ends as failed with a reason (TD-10). Streaming = Range requests on the original.
- **Pros:** Exactly the phase scope (metadata + thumbnail); fastest processing; storage = 1× the upload; download serves the original as uploaded.
- **Cons:** Rejects MOV/MKV/AVI and other codecs; MP4s with the `moov` atom at the end need an extra Range request before playback starts; no adaptive bitrate.

### Option B: Normalize to a single progressive MP4 (H.264/AAC, `+faststart`)
- Worker remuxes (`-c copy`) when codecs are compatible, otherwise transcodes.
- **Pros:** Accepts virtually any input; guaranteed fast-start playback.
- **Cons:** Transcoding a 10GB file is long and CPU-heavy; storage up to 2× (original + rendition); more failure modes — beyond the phase's literal capabilities.

### Option C: HLS with multiple renditions
- **Pros:** Adaptive quality, best playback on poor networks.
- **Cons:** Largest processing time and storage (3–4×); many objects per video; requires an HLS-capable player later — far beyond this phase's capabilities.

**Recommendation:** **Option A (original + progressive Range streaming)** — fulfils "metadata + thumbnail + streaming" without transcoding cost or extra storage; Option B remains an additive worker step if broader format support becomes a requirement.

**Decision:** A (original file, web-playable formats, progressive HTTP Range streaming)

---

## TD-08: Streaming & Download Delivery Path

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** How bytes reach the client for playback (Range → `206 Partial Content`) and for download (`Content-Disposition: attachment`). As with uploads, routing video bytes through the API would load it with every viewer. The access-control point matters because later phases add visibility rules (draft/unlisted — Phases 04/05). Thumbnails use the same path. **Depends on:** TD-01, TD-02, TD-07.

**Options:**

### Option A: Private bucket + short-lived presigned GET URLs issued by the API
- API endpoints (e.g. stream and download) check that the video exists and is `ready`, then presign `GetObject` (download variant with `ResponseContentDisposition=attachment; filename=…`) and either return the URL or answer `302` to it. The client fetches from storage, which serves Range requests natively with `206`.
- **Pros:** No video bytes through the API; Range/206 implemented by storage, not by us; one authorization point at URL issuance (ready for Phase 04/05 visibility rules); download is the same mechanism plus one parameter.
- **Cons:** URLs expire — TTL must outlast a viewing session or the client must request a new URL; presigning must use the client-reachable endpoint (same split as TD-03 A); URLs are not stable across requests.

### Option B: Public-read bucket, unguessable keys
- **Pros:** Simplest; stable, cacheable URLs; no expiry handling.
- **Cons:** Anyone with a URL keeps access forever, including to drafts and failed uploads; no control point for later visibility rules.

### Option C: Proxy streaming through the API (Range forwarding, `206` responses)
- `GET /videos/:id/stream` forwards the client's `Range` to storage and pipes the partial response.
- **Pros:** Storage never exposed to clients; full per-request control; stable URLs.
- **Cons:** Every viewer's bytes cross the API — the same performance problem TD-03 avoids, multiplied by concurrent viewers; Range parsing, `206`/`416` handling and backpressure to implement and test.

**Recommendation:** **Option A (private bucket + presigned GET)** — keeps playback and download off the API while preserving a single authorization point, and reuses the presigning infrastructure of TD-03; Range/206 is delegated to the storage that implements it natively.

**Decision:** A (private bucket + presigned GET; storage serves Range/206)
**Revisions:**
- 2026-10-26 — Phase 03 access rule clarified (AMB-1): stream and download URL issuance is authenticated and restricted to the owner channel, for `ready` videos only. Phase 04 (visibility) and Phase 05 (anonymous access) extend this rule. Rationale: owner-only until visibility rules exist.

---

## TD-09: Unique Short Video Identifier (public URL ID)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, unguessable public ID used in its URL and API path (`ENUNCIADO.md` § Persistência: "o identificador da URL única"; `project-plan.md` § Pontos de Atenção: "URL curta e única que nunca conflite"). Unguessability matters because unlisted videos (Phase 04/05) will be protected only by knowledge of the link. Runtime note: `nanoid@6` is ESM-only with `engines.node: ^22 || ^24 || >=26` — Node 25.6 (API container) is outside its declared range.

**Options:**

### Option A: 11-char base64url from `crypto.randomBytes(8)` + DB unique constraint + retry on collision
- 64 random bits → 11 URL-safe characters. Insert; on unique violation, regenerate (bounded retries). Internal PK stays UUID.
- **Pros:** Zero dependency (Node `crypto`); unguessable; the unique constraint is the hard "never conflicts" guarantee and the retry handles the negligible collision case deterministically; fixed length simplifies path validation.
- **Cons:** Own small generator + retry logic (trivially unit/integration-testable).

### Option B: `nanoid` + unique constraint
- **Pros:** Well-known, configurable alphabet/length.
- **Cons:** v6 is ESM-only and its `engines` excludes Node 25; v3 (last CommonJS) is legacy; still needs the constraint + retry for a true guarantee.

### Option C: Sqids/Hashids encoding of a sequential integer
- **Pros:** Collision-free by construction; short.
- **Cons:** Reversible and sequential — IDs are enumerable, defeating unlisted privacy; leaks upload volume; extra serial column.

### Option D: UUID primary key in the URL
- **Pros:** Nothing to build.
- **Cons:** 36 characters — not short; exposes the internal PK.

**Recommendation:** **Option A (crypto base64url + unique constraint + retry)** — short, unique and unguessable with no dependency and no Node-version friction; the constraint provides the guarantee, the randomness keeps links private.

**Decision:** A (11-char base64url from `crypto.randomBytes(8)` + unique constraint + retry)

---

## TD-10: Video Status Lifecycle & Processing-Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** `ENUNCIADO.md` requires the cycle **rascunho → processando → pronto/erro** reflected in the database, and asks what happens when processing fails. The API writes the first transitions (create → draft; complete → processing) and the worker writes the terminal ones. Two coupled questions: the state set, and the failure policy. **Depends on:** TD-03, TD-04.

**Options:**

### Option A: `status: draft → processing → ready | failed`; bounded retries for transient errors, immediate failure for invalid media; original kept
- `draft` from pre-registration until the upload is completed; `processing` when the complete call succeeds and the job is enqueued; worker sets `ready` (duration/metadata/thumbnail persisted) or `failed` with a `failure_reason`. Transient errors (storage/DB/timeouts) retry with exponential backoff (e.g. 3 attempts); invalid/unsupported media (ffprobe errors, TD-07 format check) fail immediately (BullMQ `UnrecoverableError`); after the final attempt the video is marked `failed`. The original object is kept (no reprocess endpoint in this phase). Worker transitions are conditional (`WHERE status = 'processing'`) so a re-delivered job is idempotent.
- **Pros:** Literal match to the required cycle; transient faults self-heal while bad media fails fast with an explanation; at-least-once delivery is safe.
- **Cons:** Failed videos keep their storage until a cleanup policy exists (out of scope — see Notes).

### Option B: Same states, no retries (first error → `failed`)
- **Pros:** Simplest worker; no attempt bookkeeping.
- **Cons:** A transient storage/DB hiccup permanently fails a 10GB upload the user must redo.

### Option C: Finer states (`draft → uploading → uploaded → processing → ready | failed`) + retries
- **Pros:** More granular observability.
- **Cons:** With direct-to-storage uploads (TD-03 A) the API does not observe the transfer reliably (only part-signing calls), so `uploading`/`uploaded` would be guesses; more transitions to guard and test; diverges from the cycle the challenge specifies.

**Recommendation:** **Option A** — implements exactly the required cycle, distinguishes retriable from non-retriable failures with the queue's own primitives (TD-04 A), and keeps the job idempotent under at-least-once delivery.

**Decision:** A (`draft → processing → ready | failed`; retries for transient errors, fail-fast for invalid media)
**Revisions:**
- 2026-10-26 — Meaning of "rascunho" clarified (AMB-4): `draft` is a processing-pipeline state (pre-registered, upload not yet completed). Phase 04 adds a separate publication/visibility field without migrating `status`. Rationale: matches the required cycle rascunho → processando → pronto/erro and keeps Phase 04 additive.

---

## TD-11: Upload Size & Type Enforcement

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** The 10GB limit must hold even though the API never sees the bytes (TD-03 A): a client can declare one size and upload another. The enforcement points span the create endpoint (declared metadata), the complete endpoint (actual object) and the worker (actual media). **Depends on:** TD-03, TD-07.

**Options:**

### Option A: Declared size/MIME validated at create + actual size verified at complete + media verified by the worker
- `create` rejects declared `size > 10GB` or a MIME outside the accepted set (TD-07) and sizes the number of parts accordingly; `complete` runs `HeadObject` on the assembled object and rejects (aborting/deleting it) if it exceeds 10GB; the worker's ffprobe is the authority on the actual format.
- **Pros:** Limit holds against lying clients; cheap checks (metadata only); each layer validates what it can actually observe.
- **Cons:** An oversized upload is only rejected after it was transferred to storage.

### Option B: Declared values only (create endpoint)
- **Pros:** Simplest.
- **Cons:** Trusts the client — a client can exceed 10GB by uploading more parts than declared.

**Recommendation:** **Option A** — the only option where the 10GB limit is actually enforced, at negligible cost, without routing bytes through the API.

**Decision:** A (declared size/MIME at create + actual size at complete + media verified by worker)

---

## TD-12: MinIO Container Image Source

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** `ENUNCIADO.md` fixes MinIO as the local S3-compatible storage and requires it to come up via `docker compose` with the backend. The historical image is gone: MinIO's Community Edition stopped publishing official images in Oct 2025, the repository was archived on 2026-04-25, and `minio/minio` (and `minio/mc`) now return 404 on Docker Hub (checked 2026-10-26). The archived repository's README points to AIStor Free as the vendor's successor. The goal is to keep provisioning as close as possible to the old `minio/minio` experience — `docker compose up` with no manual step — so any evaluator can bring the stack up from a fresh clone.

**Options:**

### Option A: `pgsty/silo` (community fork of MinIO, formerly `pgsty/minio`), pinned release tag
- AGPL-3.0 rebuild of the MinIO codebase maintained by PGSTY, published on Docker Hub as `docker.io/pgsty/silo` (multi-arch amd64/arm64) with `RELEASE.YYYY-MM-DDTHH-MM-SSZ` tags. Positioned by its maintainers as a drop-in swap for `minio/minio`.
- **Pros:** Same provisioning contract as `minio/minio` — `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (the whole `MINIO_*` namespace is kept), `server /data --console-address ":9001"`, ports 9000 (S3) / 9001 (console); no registration or license file; web console restored (useful for manual verification of uploaded objects/thumbnails); the standard image bundles `mc` (alias of `mcli`) and `curl`, so bucket bootstrap and the healthcheck need no extra image; same S3 API/SigV4 surface the API and worker are coded against (TD-02), keeping the production switch to AWS S3 configuration-only.
- **Cons:** Third-party build, not affiliated with MinIO Inc. — maintenance is best effort (releases every 1–2 months, CVE tracking, no SLA); stricter S3 validation than old MinIO in a few paths (see Recommendation).

### Option B: MinIO AIStor Free (`quay.io/minio/aistor/minio`)
- The vendor's official, maintained successor; free tier is full-featured on a single node.
- **Pros:** Official and patched; literally "MinIO".
- **Cons:** **Requires a license file to start** (`--license /minio.license`), obtained per user through the vendor's sign-up flow — a fresh clone cannot `docker compose up` until each evaluator requests and mounts their own license, and the file cannot sensibly be committed (commercial license; redistribution prohibited); documentation only references the `:latest` tag, hindering version pinning.

### Option C: Last official Community Edition image pinned from Quay (`quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z`)
- **Pros:** Original upstream build; same contract as before.
- **Cons:** Unmaintained since 2025 (no security fixes); availability could not be confirmed (anonymous registry access returned 401 on 2026-10-26) — a reproducibility risk for the Compose acceptance criterion.

**Recommendation:** **Option A (`pgsty/silo`, pinned release)** — the only option that preserves the `minio/minio` provisioning experience (same env vars, command, ports, console, bundled `mc`) with a maintained, pullable, license-free image, so `docker compose up` works from a fresh clone. Cautions that apply to this phase's deliverable:
- **Pin an exact release tag** (e.g. `RELEASE.2026-10-18T00-00-00Z`, verified on Docker Hub), never `latest` — the fork recommends pinning, and it keeps the environment reproducible for evaluation.
- **Use the standard image, not `-distroless`** — only the standard variant ships `curl` (healthcheck) and `mc` (bucket bootstrap); the distroless entrypoint is the `silo` binary and lacks both.
- **Multipart part order is enforced** — `CompleteMultipartUpload` with duplicate or non-ascending part numbers fails with `InvalidPartOrder` (checksum mismatches → `BadDigest`). The complete endpoint (TD-03) must sort and de-duplicate parts; this is also AWS S3's contract, so the code stays production-correct.
- **Missing bucket is an error, not an empty result** (`ListObjects` → `NoSuchBucket`) — the bucket bootstrap must finish before the API/worker start (Compose `depends_on` with a completed one-shot service), otherwise the first storage call fails.
- **Third-party maintenance** — acceptable for the local/dev scope of this deliverable; production targets AWS S3 (or AIStor) through configuration only (TD-02). Option B stays documented as the official alternative for whoever accepts the license step.

**Decision:** A (`pgsty/silo`, pinned release tag) — chosen by the user on 2026-10-26.
**Revisions:**
- 2026-10-26 — Storage test strategy clarified (IC-1): integration and e2e tests that touch storage run against the real MinIO (`pgsty/silo`) service in Compose, overriding the testing guide's local-filesystem adapter for this phase; the test environment points the public (presign) endpoint at the internal endpoint so tests can use presigned URLs from inside the container. Rationale: S3-specific paths (presigned multipart, presigned GET, Range) cannot be exercised by a local-filesystem adapter.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Bucket & object key organization | **A** (single private bucket, `videos/{videoId}/…`) | **A** |
| TD-02 | Backend | S3 client library | **A** (AWS SDK v3 + request presigner) | **A** |
| TD-03 | Backend | Upload strategy for 10GB | **A** (S3 multipart with presigned parts, client → storage) | **A** |
| TD-04 | Backend | Job queue technology | **A** (BullMQ + Redis, `@nestjs/bullmq@11`) | **A** |
| TD-05 | Backend | Video worker topology | **A** (separate process, same codebase, own container) | **A** |
| TD-06 | Backend | FFmpeg / ffprobe integration | **A** (system FFmpeg + typed `spawn` wrapper) | **A** |
| TD-07 | Backend | Processing output & streaming format | **A** (original file, web-playable formats, HTTP Range) | **A** |
| TD-08 | Backend | Streaming & download delivery path | **A** (private bucket + presigned GET; storage serves 206) | **A** |
| TD-09 | Backend | Unique short video identifier | **A** (11-char base64url from `crypto` + unique constraint + retry) | **A** |
| TD-10 | Backend | Status lifecycle & failure handling | **A** (`draft → processing → ready/failed`; retries for transient, fail-fast for invalid media) | **A** |
| TD-11 | Backend | Upload size & type enforcement | **A** (create + complete + worker checks) | **A** |
| TD-12 | Backend | MinIO container image source | **A** (`pgsty/silo`, pinned release tag) | **A** |

---

## Notes for downstream pipeline

- **Dependency graph:** TD-02 ← TD-01; TD-03 ← TD-01, TD-02; TD-05 ← TD-04; TD-06 ← TD-05; TD-08 ← TD-01, TD-02, TD-07; TD-10 ← TD-03, TD-04; TD-11 ← TD-03, TD-07; TD-03 and TD-01 (bootstrap) are constrained by TD-12's cautions (part ordering, bucket must exist before first use). If TD-03 swings to B (tus), TD-08's endpoint split and TD-11's enforcement points must be revisited; if TD-04 swings to B (pg-boss), TD-10's retry/`UnrecoverableError` mechanics change to pg-boss equivalents.
- **Public vs internal storage endpoint (TD-03 A + TD-08 A).** The API and worker reach MinIO by Compose service name (root `CLAUDE.md` § Docker Networking). Presigned URLs, however, are consumed by clients **outside** the Compose network and must be signed for a host they can resolve (`http://localhost:<published-port>` in dev) — SigV4 signs the `Host`, so the URL cannot be rewritten afterwards. Expect two env keys (internal endpoint + public endpoint), validated by Joi; the presigner bound to the public endpoint is never used for server-side calls. This is not an exception to the Docker rule (no service-to-service connection uses it). **Tests:** the e2e/integration suites run inside the `nestjs-api` container, so the test environment should set the public endpoint to the internal one, letting tests `PUT`/`GET` presigned URLs against the real MinIO.
- **MinIO image availability** is resolved by TD-12 (`pgsty/silo`, pinned release, standard variant).
- **Compose impact (implementation, not a TD):** new services in `nestjs-project/compose.yaml` — `minio` (TD-12 image), `redis` (TD-04), `video-worker` (TD-05, image with FFmpeg) — plus a one-shot bucket bootstrap using the `mc` bundled in the TD-12 image (bucket per TD-01), on which the API and worker depend.
- **Out of scope, noted as future tasks** (per root `CLAUDE.md` § Scope Limits): cleanup of abandoned multipart uploads and stale drafts (bucket lifecycle rule `AbortIncompleteMultipartUpload` + scheduled sweep); reprocessing of failed videos; transcoding (TD-07 B/C); any frontend upload/player UI; publication/visibility (Phase 04); anonymous access rules for streaming (Phase 05).
- **ESM-only packages flagged during research** (relevant only if deviating from recommendations): `@tus/server`/`@tus/s3-store` 2.x, `pg-boss` 12.x, `nanoid` 6.x, `@nestjs/bullmq` 12.x (Nest 12 line).
- **Documentation sources:** versions verified against the npm registry (`npm view`, 2026-10-26): `@aws-sdk/client-s3` 3.1157.0, `bullmq` 6.5.0, `@nestjs/bullmq` 11.0.5 (latest Nest 11 line), `fluent-ffmpeg` 2.1.3 (deprecated). Official docs consulted via context7: NestJS Queues (`/nestjs/docs.nestjs.com` — `@Processor`/`WorkerHost`, sandboxed processors without DI) and AWS SDK v3 (`/aws/aws-sdk-js-v3` — presigner, `lib-storage` multipart part-size minimum 5MB). `plan-resolve` fixes exact versions in `library-refs.md` via context7.

Sources consulted during research:
- [NestJS — Queues](https://docs.nestjs.com/techniques/queues) — `@nestjs/bullmq` official integration; sandboxed processors run without DI.
- [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) — `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`.
- [Amazon S3 — Uploading objects / multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html) — single-operation upload capped at 5GB; larger objects require multipart.
- [MinIO maintenance mode & alternatives (Vegard IT)](https://vegardit.com/en/blog/minio-alternatives/), [MinIO images disappeared from Docker Hub (StableBuild)](https://www.stablebuild.com/blog/minio-images-disappeared-from-docker-hub), [MinIO Is Dead, Long Live MinIO (pgsty)](https://silo.pgsty.com/blog/post/minio-resurrect/) — Community Edition status and image sources.
- [pgsty/silo (GitHub)](https://github.com/pgsty/minio), [Silo — Server compatibility](https://silo.pgsty.com/compatibility/server/), [Silo — Migration](https://silo.pgsty.com/compatibility/migration/) — drop-in contract (`MINIO_*` env, command, ports), bundled `mc`, stricter S3 validation (`InvalidPartOrder`, `NoSuchBucket`), tag pinning guidance. Tags verified on Docker Hub (`pgsty/silo`) on 2026-10-26.
- [Deploy MinIO AIStor as a Container](https://docs.min.io/aistor/installation/container/install/), [AIStor Subscriptions and Pricing](https://www.min.io/pricing) — license-file requirement, commercial license, redistribution terms.
- [tus Node.js server v2](https://tus.io/blog/2025/03/25/tus-node-server-v200) — Request/Response rewrite, Node ≥20.19.
- [fluent-ffmpeg on npm](https://npmjs.com/package/fluent-ffmpeg) — deprecated notice.
- [BullMQ vs Bee-Queue vs pg-boss (PkgPulse, 2026)](https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026).
