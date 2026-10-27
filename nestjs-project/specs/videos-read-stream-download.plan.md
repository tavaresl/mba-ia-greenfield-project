---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.11
target_file: nestjs-project/test/videos-read-stream-download.e2e-spec.ts
---

# Video Status, Streaming and Download Test Plan

## Application Overview

The owner reads a video's status and metadata with `GET /videos/:publicId` (used to poll processing), and obtains playback and download through `GET /videos/:publicId/stream` and `GET /videos/:publicId/download`, which answer `302` to short-lived presigned storage URLs. Storage serves `Range` requests with `206 Partial Content` (streaming without full download); the download URL forces `Content-Disposition: attachment`. Stream/download require a `ready` video; non-owners get `404`, anonymous callers `401`.

## Test Scenarios

### 1. Status, stream and download (SI-03.11)

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduce the `main.ts` globals (`ValidationPipe` with `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`), `app.init()`; obtain `DataSource`, `ThrottlerStorageService`, `StorageService` and the `Video` repository. `beforeEach`: `cleanAllTables(dataSource)`, `throttlerStorage.storage.clear()`, delete bucket objects under `videos/`; create two confirmed users (owner and stranger) with the register → confirm → login helper pattern of `test/auth.e2e-spec.ts`. Fixture `seedVideo(owner, status, opts)`: saves a `Video` row directly through the repository in the owner's channel with the given `status` (and, for `ready`, metadata columns, `original_file_name: "my clip.mp4"`), and for `ready` writes 4096 arbitrary bytes at `storage_key` with `StorageService.putObject` — no worker, queue or FFmpeg involved (per the SI-03.11 test setup note). Test env (`src/test/setup-test-env.ts`): `S3_PUBLIC_ENDPOINT=S3_ENDPOINT`, so `Location` URLs are fetchable from the test container. `afterAll`: `app.close()`.

#### 1.1. owner-reads-status-and-metadata

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Seed a `draft` video; GET /videos/:publicId as the owner
    - expect: status `200`
    - expect: body `status` is `"draft"`, metadata fields (`duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `container_format`, `bitrate`) are `null` and `thumbnail_url` is `null`
  2. Seed a `ready` video with metadata and a `thumbnail_key` (object written); GET /videos/:publicId as the owner
    - expect: status `200`
    - expect: body `status` is `"ready"`, metadata fields equal the seeded values and `thumbnail_url` is a non-empty URL

#### 1.2. stream-redirects-to-range-capable-url

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Seed a `ready` video; GET /videos/:publicId/stream as the owner (do not follow redirects)
    - expect: status `302` with a non-empty `Location` header
  2. Request the `Location` URL with header `Range: bytes=0-1023` (plain HTTP client, no `Authorization` header)
    - expect: status `206`
    - expect: body length is exactly 1024 bytes and `Content-Range` starts with `bytes 0-1023/4096`

#### 1.3. download-redirects-to-attachment-url

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Seed a `ready` video with `original_file_name: "my clip.mp4"`; GET /videos/:publicId/download as the owner (do not follow redirects)
    - expect: status `302` with a non-empty `Location` header
  2. Request the `Location` URL
    - expect: status `200`
    - expect: `Content-Disposition` is `attachment; filename="my clip.mp4"`

#### 1.4. stream-and-download-require-ready-video

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Seed one video for each status `draft`, `processing` and `failed`
  2. As the owner, GET /videos/:publicId/stream and GET /videos/:publicId/download for each of them
    - expect: every response is `409` with `error: "VIDEO_NOT_READY"` and no `Location` header

#### 1.5. non-owner-and-anonymous-access-denied

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-10-27T00:42:00Z

**Steps:**
  1. Seed a `ready` video for the owner
  2. As the stranger, call GET /videos/:publicId, /stream and /download
    - expect: each response is `404` with `error: "VIDEO_NOT_FOUND"`
  3. Without an `Authorization` header, call the same three routes
    - expect: each response is `401`
