---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1157.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-27T00:01:02Z"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1157.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-27T00:01:02Z"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/docs.nestjs.com"
    fetched_at: "2026-10-27T00:01:02Z"
  "bullmq":
    version: "^6.5.0"
    context7_id: "/taskforcesh/bullmq/v6.3.11"
    fetched_at: "2026-10-27T00:01:02Z"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-26T21:00:16-03:00"
---

# Library References

Distilled from Context7 (plus the npm registry for version pinning, checked 2026-10-26). Scope: the surfaces Phase 03 TDs actually use — presigned multipart upload and presigned GET (TD-02/TD-03/TD-08), the processing queue and worker (TD-04/TD-05/TD-10).

**Version notes (installed stack: Nest 11.1.16, Node 25.6, CommonJS, Jest 30 + ts-jest):**

- `@nestjs/bullmq` **must stay on the 11.x line** — `12.0.0` targets Nest 12 and is ESM (`"type": "module"`). `11.0.5` peers: `@nestjs/core|common ^10 || ^11`, `bullmq ^3 || ^4 || ^5 || ^6`.
- `bullmq` latest is `6.5.0`; Context7's newest indexed docs are `v6.3.11` (same major — APIs below are unchanged within 6.x).
- `@aws-sdk/*` 3.x is CommonJS-compatible (`require` works) and requires Node ≥ 20.
- The NestJS docs Context7 serves track the `master` branch (some snippets use `import.meta.dirname`, i.e. ESM/Nest 12 style). The APIs used here (`forRootAsync`, `registerQueue`, `@InjectQueue`, `@Processor` + `WorkerHost`, `@OnWorkerEvent`) are the same in `@nestjs/bullmq@11`; use `__dirname`-style CommonJS where a path is needed.

---

### @aws-sdk/client-s3

**Used for:** bucket/object operations from the API and the worker (TD-01, TD-02, TD-03, TD-11).

- Import only what is used — bare `S3Client` + individual commands (`import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3"`), sent with `client.send(new XCommand({...}))`. CommonJS `require` is also supported.
- **Create one client and reuse it** — "Creating a new client for each loop iteration increases work for the calling program by forcing the client to re-compute credentials and endpoints." → one provider instance per endpoint (internal vs. public — see presigner).
- **Custom endpoint:** when targeting a non-AWS endpoint, set `endpoint` on the client (documented for v3 clients generally). For MinIO also set `forcePathStyle: true` (path-style `http://host:9000/bucket/key`) and a `region` (any fixed value, e.g. `us-east-1`) plus static `credentials`.
- Multipart lifecycle commands needed by TD-03: `CreateMultipartUploadCommand` (returns `UploadId`), `UploadPartCommand` (presigned for the client — see below), `ListPartsCommand` (resume: returns already-uploaded `PartNumber`/`ETag`), `CompleteMultipartUploadCommand` (`MultipartUpload: { Parts: [{ PartNumber, ETag }] }` — **sorted ascending, no duplicates**, see TD-12 caution `InvalidPartOrder`), `AbortMultipartUploadCommand`.
- `HeadObjectCommand` → `ContentLength` of the assembled object (TD-11 actual-size check at complete).
- Worker: `GetObjectCommand` to read the original (or presign it for ffprobe/ffmpeg HTTP input — TD-06), `PutObjectCommand` to write `thumbnail.jpg`.
- **Data-integrity defaults:** the SDK computes checksums automatically on uploads (CRC-32 by default for `PutObject`/multipart via `ChecksumAlgorithm`); a pre-calculated checksum disables automatic computation. ⚠ Not surfaced by Context7 but known from SDK release notes (v3.729.0+): the default `requestChecksumCalculation: "WHEN_SUPPORTED"` can add checksum headers/query params that S3-compatible servers or presigned browser uploads may reject; set `requestChecksumCalculation: "WHEN_REQUIRED"` and `responseChecksumValidation: "WHEN_REQUIRED"` on the client if presigned `UploadPart` PUTs fail signature/checksum validation against MinIO. **Verify in the storage SI.**

### @aws-sdk/s3-request-presigner

**Used for:** presigned `UploadPart` URLs (TD-03) and presigned `GetObject` URLs for stream/download (TD-08).

```ts
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
const url = await getSignedUrl(client, new GetObjectCommand(params), { expiresIn: 3600 });
```

- `expiresIn` defaults to **900 seconds** when omitted — set it explicitly (part URLs: long enough for one part; stream URLs: long enough for a viewing session — TD-08 cons).
- Any command can be presigned: `new UploadPartCommand({ Bucket, Key, UploadId, PartNumber })` for client part uploads; `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })` for downloads.
- SigV4 signs the `Host` — presign with an `S3Client` configured with the **public** endpoint (client-reachable), never rewrite the URL host afterwards. In the test environment the public endpoint equals the internal one (TD-12 revision, IC-1).

### @nestjs/bullmq

**Used for:** queue registration in the API (producer) and the processor in the worker process (TD-04, TD-05).

```ts
BullModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => ({
    connection: { host: configService.get('QUEUE_HOST'), port: configService.get('QUEUE_PORT') },
  }),
  inject: [ConfigService],
});
```

- With BullMQ the connection key is **`connection`** (the legacy Bull `redis` key is for `@nestjs/bull`). In this project, inject the namespaced `registerAs` config (`@Inject(xxxConfig.KEY)` / `inject: [xxxConfig.KEY]`) per the inherited Phase 01 convention instead of raw `ConfigService.get`.
- Register a queue with `BullModule.registerQueue({ name: '…' })`; inject it with `@InjectQueue('…') private queue: Queue` (`Queue` from `bullmq`) and enqueue with `queue.add(name, data, opts)`.
- Consumer: `@Processor('…') class X extends WorkerHost { async process(job: Job) {…} }`; register it as a provider of the worker's module only (TD-05 A keeps it out of the API). The value returned by `process()` is stored on the job.
- Worker events: `@OnWorkerEvent('active' | 'completed' | 'failed' …)` methods inside the `@Processor` class.
- **Sandboxed processors** (`registerQueue({ processors: [path] })`) run in a forked process **without DI** — not used (TD-05 option C rejected).
- Testing: the queue provider token is `getQueueToken(name)` (`module.get<Queue>(getQueueToken('…'))`), per the project testing guide (`references/external-systems.md`).

### bullmq

**Used for:** job options, retry/failure semantics and worker behavior (TD-04, TD-10).

```ts
import { Worker, UnrecoverableError } from 'bullmq';
// inside the processor:
throw new UnrecoverableError('Unsupported media');   // → failed, no retries
await queue.add('process-video', { videoId }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } });
```

- **`UnrecoverableError`** moves the job to `failed` **without retries, overriding `attempts`** — TD-10 fail-fast for invalid media (ffprobe errors / unsupported codecs).
- `attempts` + `backoff` (number = fixed delay; `{ type: 'exponential', delay }` for exponential) for transient errors; a custom `settings.backoffStrategy(attemptsMade)` on the Worker can return `-1` to fail immediately.
- Timeouts: abort long work with an `AbortController` and throw `UnrecoverableError('Timeout')` to avoid retries (pattern from the docs — applicable to FFmpeg runs).
- Auto-removal of finished jobs: `removeOnComplete` / `removeOnFail` (`{ count: N }` or `true`).
- Delivery is at-least-once: processors must be idempotent (TD-10 conditional status transitions).
