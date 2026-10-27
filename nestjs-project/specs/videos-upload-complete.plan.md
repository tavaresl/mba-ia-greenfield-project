---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete Test Plan

## Application Overview

`POST /videos/:publicId/upload/complete` closes the multipart upload of the owner's `draft` video, verifies the real size of the assembled object against `VIDEO_MAX_UPLOAD_BYTES`, moves the video `draft → processing` and enqueues one `process-video` job (payload `{ videoId }`) on the `video-processing` queue. Storage rejections map to `422 INVALID_UPLOAD_PARTS`; oversize objects are deleted and the video ends `failed` with `422 UPLOAD_SIZE_EXCEEDED`; a video no longer `draft` returns `409`.

## Test Scenarios

### 1. Upload completion and processing enqueue (SI-03.7)

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduce the `main.ts` globals (`ValidationPipe` with `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`), `app.init()`; obtain `DataSource`, `ThrottlerStorageService`, `StorageService`, the `Video` repository and the queue via `getQueueToken('video-processing')`. `beforeEach`: `cleanAllTables(dataSource)`, `throttlerStorage.storage.clear()`, delete bucket objects under `videos/`, `queue.obliterate({ force: true })`; create a confirmed owner with the register → confirm → login helper pattern of `test/auth.e2e-spec.ts`. Helper `uploadParts(publicId, sizes[])`: requests presigned URLs for parts `1..n` and `PUT`s random bytes of the given sizes, returning `[{ part_number, etag }]`. Test env (`src/test/setup-test-env.ts`): `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`, `VIDEO_MAX_UPLOAD_BYTES=12582912`, `QUEUE_PREFIX=test` (no running worker consumes these jobs), `S3_PUBLIC_ENDPOINT=S3_ENDPOINT`. `afterAll`: `app.close()`.

#### 1.1. completes-upload-and-enqueues-processing

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Owner creates a draft (`file_size: 6291456`, `mime_type: "video/mp4"` → 2 parts) and uploads parts of 5242880 and 1048576 bytes
  2. POST /videos/:publicId/upload/complete with `parts` listed in descending order (`[{ part_number: 2, … }, { part_number: 1, … }]`)
    - expect: status `202`
    - expect: body is `{ "id": "<publicId>", "status": "processing" }`
  3. Load the video row and inspect storage and queue
    - expect: `status = 'processing'`, `file_size = 6291456`, `upload_id` is null
    - expect: `headObject(storage_key)` reports 6291456 bytes
    - expect: the queue holds exactly one job named `process-video` with `data` `{ "videoId": "<row.id>" }`

#### 1.2. rejects-invalid-part-etag

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Owner creates a draft (`file_size: 6291456`) and uploads both parts
  2. POST /videos/:publicId/upload/complete with the correct part numbers but part 2's `etag` replaced by `"\"0000000000000000000000000000000\""`
    - expect: status `422`
    - expect: body `error` is `"INVALID_UPLOAD_PARTS"`
    - expect: the video row stays `status = 'draft'` and no job exists in the queue

#### 1.3. rejects-object-above-max-upload-size

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Owner creates a draft declaring `file_size: 12582912` (→ `part_count: 3`) and uploads three parts of 5242880 bytes (15728640 bytes in total — above the test `VIDEO_MAX_UPLOAD_BYTES` of 12582912)
  2. POST /videos/:publicId/upload/complete with the three parts
    - expect: status `422`
    - expect: body `error` is `"UPLOAD_SIZE_EXCEEDED"`
  3. Inspect the row, storage and queue
    - expect: `status = 'failed'` and `failure_reason = 'UPLOAD_SIZE_EXCEEDED'`
    - expect: `headObject(storage_key)` fails with not-found (object deleted)
    - expect: no job exists in the queue

#### 1.4. second-complete-is-rejected-without-new-job

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Owner completes an upload successfully (as in 1.1)
  2. POST /videos/:publicId/upload/complete again with the same body
    - expect: status `409`
    - expect: body `error` is `"VIDEO_NOT_UPLOADABLE"`
    - expect: the queue still holds exactly one `process-video` job for the video

#### 1.5. rejects-missing-parts-array

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Owner creates a draft, then POST /videos/:publicId/upload/complete with body `{}`
    - expect: status `400`
    - expect: body `error` is `"VALIDATION_ERROR"`
    - expect: the video row stays `status = 'draft'` with a non-null `upload_id`
