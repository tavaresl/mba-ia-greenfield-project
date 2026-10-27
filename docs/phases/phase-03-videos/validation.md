---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 16
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-26T20:45:19-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-26T20:34:52-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Testing guide prescribes local-FS storage in dev/tests; TD-12 runs MinIO in Compose"
  - id: AMB-1
    status: open
    summary: "Who may stream/download in Phase 03 (owner, authenticated, anonymous)?"
  - id: AMB-2
    status: open
    summary: "Which data the draft carries at pre-registration (title source)"
  - id: AMB-3
    status: open
    summary: "Which 'metadados' are extracted and persisted besides duration"
  - id: AMB-4
    status: open
    summary: "'Rascunho' meaning in Phase 03 vs Phase 04 draft→publication flow"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Bucket & Object Key Organization"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — S3 Client Library (API + Worker)"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Upload Strategy for Files up to 10GB"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Background Job Queue Technology"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Video Worker Topology"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — FFmpeg / ffprobe Integration"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Processing Output & Streaming Format"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Streaming & Download Delivery Path"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Unique Short Video Identifier (public URL ID)"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Video Status Lifecycle & Processing-Failure Handling"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Upload Size & Type Enforcement"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

- **IC-1** — `## Testing Requirements` (from `testing-guide-nestjs-project` → `references/external-systems.md`) states for Object Storage: "Local filesystem storage in development and tests. S3 in production." and maps "Service with side-effect dep (email, storage)" to "real capture service (Mailpit) or local adapter". The decided current-scope TD `phase-03-videos/TD-12` provisions MinIO (`pgsty/silo`) as the S3-compatible storage of the local Compose environment ("so `docker compose up` works from a fresh clone"), and the pending TDs TD-01/TD-02/TD-03/TD-08 are built on the S3 API (presigned multipart, presigned GET), which a local-filesystem adapter cannot exercise. The two sources prescribe different storage for dev/tests. Explicit choice: (a) storage integration/e2e tests run against the real MinIO service in Compose (testing-guide strategy overridden for this phase — record the override as a Revision/convention so `plan-build` emits it in Testing Requirements); (b) keep the testing-guide's local-filesystem adapter for tests and MinIO only for runtime (presign/multipart paths then untested against a real S3 API); (c) update the testing guide's external-systems strategy to "real S3-compatible service in Docker" project-wide.

### Ambiguities

- **AMB-1** — "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" do not state **who** may stream/download in Phase 03. Neighbor Phase 05 owns "Acesso anônimo à visualização de vídeos" and "Botão de download do vídeo", and Phase 04 owns visibility (público/unlisted) and publication — so the Phase 03 access rule could plausibly be owner-only, any authenticated user, or anonymous for `ready` videos. Needed by the Authorization Matrix. Explicit choice: define the Phase 03 access rule for stream/download endpoints (e.g., (a) owner-only until Phase 04/05 add visibility and anonymous access; (b) any request for a `ready` video, anonymous included; (c) any authenticated user).
- **AMB-2** — "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" does not state which data the draft row carries at creation. Editing of título/descrição/categoria belongs to Phase 04, but the draft must exist before upload completes. Explicit choice: define the pre-registration payload — e.g., (a) title required in the create request; (b) title derived from the original file name, editable in Phase 04; plus whether original file name / declared size / MIME are persisted.
- **AMB-3** — "Processamento automático do vídeo após upload (extração de duração e metadados)" — "metadados" is open-ended. Explicit choice: list the metadata persisted (e.g., width/height, video/audio codecs, container format, bitrate, frame rate, size) and their storage form (typed columns vs. a single structured column), so the Data Model can be specified.
- **AMB-4** — The term "rascunho" appears in this phase ("Pré-cadastro automático do vídeo como rascunho") and in neighbor Phase 04 ("fluxo de rascunho e publicação"). It is unclear whether Phase 03's "rascunho" is a **processing-pipeline state** (video not yet uploaded/processed — as pending TD-10 Option A models with `status: draft → processing → ready | failed`) or the **editorial state** "not yet published" that Phase 04 transitions to "publicado". The two readings imply different Data Models (a `ready` video is still unpublished under the editorial reading). Explicit choice: fix the meaning of "rascunho" for Phase 03 and state how Phase 04's publication will relate to it (e.g., separate publication field added in Phase 04 vs. extending the same status enum).

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Bucket & Object Key Organization. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-2** — TD-02 pending — S3 Client Library (API + Worker). Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-3** — TD-03 pending — Upload Strategy for Files up to 10GB. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-4** — TD-04 pending — Background Job Queue Technology. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-5** — TD-05 pending — Video Worker Topology. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-6** — TD-06 pending — FFmpeg / ffprobe Integration. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-7** — TD-07 pending — Processing Output & Streaming Format. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-8** — TD-08 pending — Streaming & Download Delivery Path. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-9** — TD-09 pending — Unique Short Video Identifier (public URL ID). Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-10** — TD-10 pending — Video Status Lifecycle & Processing-Failure Handling. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.
- **OQ-11** — TD-11 pending — Upload Size & Type Enforcement. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate 03.

### UI Coverage Gaps

_None._ _(UI not in scope — `## UI Inventory` absent.)_

## Resolved Issues

_No issues resolved yet._
