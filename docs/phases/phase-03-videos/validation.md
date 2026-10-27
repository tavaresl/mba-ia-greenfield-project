---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-26T21:01:38-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-26T21:00:16-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Testing guide prescribes local-FS storage in dev/tests; TD-12 runs MinIO in Compose"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-1
    status: resolved
    summary: "Who may stream/download in Phase 03 (owner, authenticated, anonymous)?"
    resolved_by: phase-03-videos/TD-08
  - id: AMB-2
    status: resolved
    summary: "Which data the draft carries at pre-registration (title source)"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-3
    status: resolved
    summary: "Which 'metadados' are extracted and persisted besides duration"
    resolved_by: phase-03-videos/TD-06
  - id: AMB-4
    status: resolved
    summary: "'Rascunho' meaning in Phase 03 vs Phase 04 draft→publication flow"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Bucket & Object Key Organization"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — S3 Client Library (API + Worker)"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Upload Strategy for Files up to 10GB"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Background Job Queue Technology"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Video Worker Topology"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — FFmpeg / ffprobe Integration"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Processing Output & Streaming Format"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Streaming & Download Delivery Path"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Unique Short Video Identifier (public URL ID)"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Video Status Lifecycle & Processing-Failure Handling"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Upload Size & Type Enforcement"
    resolved_by: phase-03-videos/TD-11
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._ _(UI not in scope — `## UI Inventory` absent.)_

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-12)_ — Testing guide prescribes local-FS storage in dev/tests; TD-12 runs MinIO in Compose. Resolution: storage integration/e2e tests run against the real MinIO in Compose (testing-guide strategy overridden for this phase); recorded as a Revision on TD-12.
- **AMB-1** _(resolved_by phase-03-videos/TD-08)_ — Who may stream/download in Phase 03. Clarified: authenticated, owner channel only, `ready` videos only; Phases 04/05 extend. Recorded as a Revision on TD-08.
- **AMB-2** _(resolved_by phase-03-videos/TD-03)_ — Data carried by the draft at pre-registration. Clarified: `title` required at create, plus original file name, declared size and MIME. Recorded as a Revision on TD-03.
- **AMB-3** _(resolved_by phase-03-videos/TD-06)_ — Which metadata are persisted. Clarified: typed columns for duration, width, height, video codec, audio codec, container format, bitrate, size. Recorded as a Revision on TD-06.
- **AMB-4** _(resolved_by phase-03-videos/TD-10)_ — Meaning of "rascunho". Clarified: processing-pipeline state; Phase 04 adds a separate publication/visibility field. Recorded as a Revision on TD-10.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 decided: A (single private bucket, `videos/{videoId}/…`).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 decided: A (AWS SDK v3).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 decided: A (S3 multipart with presigned part URLs).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 decided: A (BullMQ + Redis).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 decided: A (separate worker process, same codebase).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 decided: A (system FFmpeg + typed spawn wrapper).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 decided: A (original file + HTTP Range streaming).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 decided: A (private bucket + presigned GET).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 decided: A (crypto base64url + unique constraint + retry).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 decided: A (draft → processing → ready | failed with retry policy).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 decided: A (create + complete + worker checks).
