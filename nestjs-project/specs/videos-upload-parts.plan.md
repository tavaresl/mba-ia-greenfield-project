---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.6
target_file: nestjs-project/test/videos-upload-parts.e2e-spec.ts
---

# Upload Parts and Cancellation Test Plan

## Application Overview

While a video is `draft` with an open multipart upload, its owner can request presigned `UploadPart` URLs (`POST /videos/:publicId/upload/parts`), send part bytes directly to storage, list the parts already stored to resume an interrupted upload (`GET /videos/:publicId/upload/parts`) and cancel the upload (`DELETE /videos/:publicId/upload`), which aborts the multipart upload and deletes the draft. Non-owners get `404` exactly as for unknown ids; videos no longer in `draft` reject the operations with `409`.

## Test Scenarios

### 1. Upload parts, resume listing and cancellation (SI-03.6)

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduce the `main.ts` globals (`ValidationPipe` with `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`), `app.init()`; obtain `DataSource`, `ThrottlerStorageService`, `StorageService` and the `Video` repository. `beforeEach`: `cleanAllTables(dataSource)`, `throttlerStorage.storage.clear()`, delete bucket objects under `videos/`; create two confirmed users (owner and stranger) with the register → confirm → login helper pattern of `test/auth.e2e-spec.ts`; the owner creates a draft with `POST /videos` (`file_size: 11534336`, `mime_type: "video/mp4"` → `part_count: 3`). Test env (`src/test/setup-test-env.ts`): `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`, `S3_PUBLIC_ENDPOINT=S3_ENDPOINT` (presigned URLs reachable from the test container). `afterAll`: `app.close()`.

#### 1.1. signs-requested-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos/:publicId/upload/parts as the owner with body `{ "part_numbers": [1, 2] }`
    - expect: status `200`
    - expect: body `parts` has two entries with `part_number` `1` and `2`, each with a non-empty `url` pointing at the storage endpoint
    - expect: body `expires_in` equals `S3_UPLOAD_URL_TTL_SECONDS`

#### 1.2. uploaded-part-is-listed-for-resume

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos/:publicId/upload/parts as the owner with `{ "part_numbers": [1] }` and `PUT` 5242880 bytes to the returned `url` (plain HTTP client, no `Authorization` header)
    - expect: the `PUT` returns `200` with an `ETag` header
  2. GET /videos/:publicId/upload/parts as the owner
    - expect: status `200`
    - expect: body `parts` contains exactly one entry with `part_number: 1`, `etag` equal to the `ETag` from step 1 and `size: 5242880`

#### 1.3. rejects-part-number-above-part-count

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos/:publicId/upload/parts as the owner with `{ "part_numbers": [4] }` (the draft has `part_count: 3`)
    - expect: status `400`
    - expect: body `error` is `"VALIDATION_ERROR"`

#### 1.4. non-owner-gets-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. As the stranger, call POST /videos/:publicId/upload/parts (`{ "part_numbers": [1] }`), GET /videos/:publicId/upload/parts and DELETE /videos/:publicId/upload on the owner's video
    - expect: each response is `404` with `error: "VIDEO_NOT_FOUND"`
  2. As the owner, call the same three routes with a well-formed but non-existent id (e.g. `AAAAAAAAAAA`)
    - expect: each response is `404` with `error: "VIDEO_NOT_FOUND"` — same status and body shape as step 1
  3. Load the owner's video row
    - expect: it still exists with `status = 'draft'` and a non-null `upload_id`

#### 1.5. non-draft-video-is-not-uploadable

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Set the owner's video `status` to `'processing'` through the repository
  2. As the owner, call POST /videos/:publicId/upload/parts (`{ "part_numbers": [1] }`), GET /videos/:publicId/upload/parts and DELETE /videos/:publicId/upload
    - expect: each response is `409` with `error: "VIDEO_NOT_UPLOADABLE"`
    - expect: the video row still exists

#### 1.6. cancel-aborts-upload-and-deletes-draft

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Record the draft's `storage_key` and `upload_id`, then DELETE /videos/:publicId/upload as the owner
    - expect: status `204`
    - expect: no `videos` row exists with that `public_id`
    - expect: listing the parts of the recorded `upload_id` in storage fails with `NoSuchUpload` (the multipart upload was aborted)
