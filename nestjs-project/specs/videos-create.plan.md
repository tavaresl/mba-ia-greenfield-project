---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` pre-registers a video as `draft` in the caller's channel at the moment the upload starts and opens the S3 multipart upload, returning the part plan (`part_size`, `part_count`) the client uses to send the file directly to storage. Video bytes never pass through the API. The endpoint is authenticated, validates the declared file (≤ 10 GiB, `video/mp4` or `video/webm`) and is exempt from the auth rate limit.

## Test Scenarios

### 1. POST /videos (SI-03.5)

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduce the `main.ts` globals (`ValidationPipe` with `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`), `app.init()`; obtain `DataSource`, `ThrottlerStorageService` and `StorageService`. `beforeEach`: `cleanAllTables(dataSource)`, `throttlerStorage.storage.clear()`, delete bucket objects under `videos/` (test storage helper). Authenticated users are created with the register → confirm → login helper pattern of `test/auth.e2e-spec.ts`. Test env (`src/test/setup-test-env.ts`): `VIDEO_UPLOAD_PART_SIZE_BYTES=5242880`, `VIDEO_MAX_UPLOAD_BYTES=12582912`, `QUEUE_PREFIX=test`, `S3_PUBLIC_ENDPOINT=S3_ENDPOINT`. `afterAll`: `app.close()`.

#### 1.1. creates-draft-and-returns-part-plan

**Covers AC:** #1, #3
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos with `Authorization: Bearer <token>` and body `{ "title": "My video", "file_name": "clip.mp4", "file_size": 11534336, "mime_type": "video/mp4" }`
    - expect: status `201`
    - expect: body `id` is an 11-character base64url string, `title` is `"My video"`, `status` is `"draft"`
    - expect: body `part_size` is `5242880` (the configured `VIDEO_UPLOAD_PART_SIZE_BYTES`) and `part_count` is `3` (`ceil(11534336 / 5242880)`)
  2. Load the `videos` row by `public_id = body.id`
    - expect: `status = 'draft'`, `channel_id` equals the caller's channel id, `upload_id` is not null
    - expect: `storage_key` matches `videos/<row.id>/original.mp4`, `declared_size = 11534336`, `mime_type = 'video/mp4'`, `original_file_name = 'clip.mp4'`

#### 1.2. accepts-the-10-gib-maximum-declared-size

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos with a valid token and body `{ "title": "Big", "file_name": "big.mp4", "file_size": 10737418240, "mime_type": "video/mp4" }`
    - expect: status `201`
    - expect: body `part_count` equals `ceil(10737418240 / part_size)` and is ≤ `10000` (with the default part size of 104857600 this is `103` — asserted by the `VideosService` unit test, since the test env uses 5 MiB parts)

#### 1.3. rejects-file-size-above-10-gib

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos with a valid token and `file_size: 10737418241` (other fields valid)
    - expect: status `400`
    - expect: body `error` is `"VALIDATION_ERROR"` and `message` mentions `file_size`
    - expect: no row exists in `videos`

#### 1.4. rejects-unsupported-mime-type

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos with a valid token and `mime_type: "video/quicktime"` (other fields valid)
    - expect: status `400`
    - expect: body `error` is `"VALIDATION_ERROR"` and `message` mentions `mime_type`
    - expect: no row exists in `videos`

#### 1.5. requires-authentication

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos with a valid body and no `Authorization` header
    - expect: status `401`
    - expect: no row exists in `videos`

#### 1.6. generates-distinct-public-ids

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. POST /videos twice with the same valid token and body
    - expect: both responses are `201`
    - expect: the two `id` values differ, and two `videos` rows exist with those `public_id` values

#### 1.7. not-rate-limited-by-auth-throttler

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Obtain a token, then POST /videos 12 times in a row with a valid body (well within one minute)
    - expect: all 12 responses are `201` — none is `429`
