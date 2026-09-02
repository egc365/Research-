# Research Operations

A small control plane over ordinary files. The filesystem remains the content plane. SQLite records workspace roots, current artifact state, checksums, immutable promoted snapshots, and an append-only transition log. UI capabilities are loaded as plugins instead of accumulating inside one Card Workshop page.

This repository is the clean-room successor to the useful parts of Card Workshop. It deliberately does **not** import the old D1 schema, card classifications, generated-card pipeline, or Wiki routing authority.

## What V0 does

- Adds real absolute folder paths as workspaces and remembers them in SQLite.
- Renders a lazy parent/child file tree from the real filesystem.
- Opens and edits text/Markdown files in place.
- Uses the file path as the registry primary key and SHA-256 as version/content evidence.
- Rejects stale editor writes when the file changed underneath the UI.
- Runs deterministic preflight plugins before mutation.
- Tracks `working → candidate → validated → promoted` state.
- Requires `actor=human` for promotion.
- Freezes exact promoted bytes in an immutable snapshot while allowing the working file to change afterward.
- Keeps an append-only governance event log.
- Loads Governance, History, Diff, Preflight, Trajectory, Moves, and Execution state panels through the same plugin host.
- Stores only run/span bindings for DeepSeek Harness provenance. DeepSeek's append-only session log remains the trace authority.

## V1 hardening on top of V0

- **Two surfaces, one store.** The owner surface (default `:8787`) serves the UI and honors the request actor. The agent surface (default `:8788`, `AGENT_PORT`) is API-only and forces `actor=agent` at the transport boundary, so human-only promotion is structural, not self-reported. Agents point their tools at the agent port.
- **Demotion on any content change.** Editing a `candidate` or `validated` file — through the UI or externally on disk — demotes it to `working` with a `WRITE_DEMOTION` event. Promotion can only apply to bytes the validator saw.
- **Validation receipts.** `candidate → validated` requires deterministic server-side validator receipts (the preflight policy rules run as validators); receipts record the checksum they were minted against and are refused if the bytes differ. Callers cannot supply their own receipts through the governance plugin.
- **Move detection.** A registered path missing from disk is rematched against unregistered files by checksum; accepting the remap re-keys the registry row and promoted snapshots in one transaction and appends a `MOVE` event. Owner surface only.
- **Execution state (SKILL.state, arXiv 2608.26263).** Per-run bounded structured state: agents propose JSON patches (`null` deletes a key); the runtime validates, merges (`Σ_{t+1} = Σ_t ⊕ ΔΣ_t`), and versions. Malformed or stale-version patches change nothing. Reasoning traces are never stored.
- **Ledger counts.** Workspace counts and recent activity come from the registry and event ledger only, never by reading raw files. The statistics contribution is retired.

## Composable UI (V1, `feature/composable-ui-v1`)

The UI has no domain identity. `public/kernel.js` is a blank composition
kernel that owns only: workspace selection, the plugin manager, the slot
renderer, plugin lifecycle (mount → dispose), the selected file/card, the
active station, and the shared event bus + services. A fresh workspace with
nothing enabled renders an empty frame: *Workspace — No views loaded — + Add
plugin*. Everything with a name (tree, editor, diff, governance)
arrives as a plugin.

Three levels:

- **Kernel** — no substantive behavior.
- **Stations** (`plugin_kind='station'`) — user-facing composed tools: file
  workbench (authoring), revision center (the :8880 workflow ported: dual
  document view, transcript cards, amendments, decisions), validation center
  (review candidates/validated and Promote — the single final verb,
  human-only), dashboard, provenance viewer, execution state, project
  creator. A workspace chooses which stations are enabled, and the owner can
  define new stations from the plugin manager (＋ New station) — a pure
  wiring row, no code.
- **Contributions** (`plugin_kind='contribution'`) — behaviors coded once in
  `public/contrib/*.js` (filesystem-tree, markdown-editor,
  dual-document-view, diff-renderer, card-rail, amendment-editor,
  revision-timeline, actor-filter, provenance-block, state-badge,
  promotion-control (validation language; Promote appears exactly once),
  candidate-list (validation queue card wall), decision-controls,
  validation-result, label-editor (dialog from the tree; labels/path_labels in
  the crosswalk), project-create-form, trace-lanes-view,
  execution-state-view, inbox, activity-view). Stations compose them; no
  contribution is copied into two stations, and contributions talk only
  through the kernel bus and services — never by importing each other.

Inbox is a top-level nav dropdown, not a station. It lists artifacts in
`candidate` or `validated` (the two states that need a verdict), grouped by
workspace, with a count badge on the button. Point it at a workspace-relative
folder with config `{ watch: 'outputs' }`; the default watches nothing. That
key lives on the workspace `inbox` preference (chrome) or on an inbox wiring
row. Files in the watched folder that are not yet registered show a register-
as-candidate action. Activity is a separate contribution (`activity-view`) on
the Provenance station, after the timeline, and listens to `actor-filter`.

SQLite is the composition crosswalk (routing/configuration, never content):
`ui_plugins` (the catalog, synced from `plugins/registry.mjs` at boot without
overwriting owner enabled-flags), `workspace_plugins` (which stations a
workspace enables — zero rows for a fresh workspace, which *is* the empty
frame), `station_contributions` (slot wiring, seeded only when a station has
no rows, so owner rewiring survives restarts).

New governed records: **amendments** (append-only rev-per-card proposals
against a document block; the document itself is never touched) and
**decisions** (record-only `accept` | `needs-more-work` in the event ledger).
All composition writes and decisions return 403 on the agent surface, tested
beside the promotion guard; agents may propose amendments and are stamped
`actor=agent` regardless of what they claim.

## Run

Requires Node 22.5+ because V0 uses the built-in `node:sqlite` module.

```bash
npm test
npm start
```

Open `http://127.0.0.1:8787` and select **＋ Workspace** — name a folder,
create it or register it as-is. A fresh workspace enables nothing; pick
stations in **Plugins ⚙**.

The `revision` service proxies transcript sessions/cards read-only from the
Revision Center at :8880 (`REVISION_CENTER_BASE` to override) and degrades to
empty answers with a note when it is down. Amendments and decisions always
land in this app's own store.

The control database defaults to:

```text
.research-ops/control.sqlite3
```

Override it with `RESEARCH_OPS_DB=/absolute/path/control.sqlite3`.

## Control-plane schema

The minimum durable tables are:

- `workspace_roots` — folders the owner explicitly added to the app.
- `artifact_registry` — path, lifecycle state, current checksum, promoted checksum, run/span binding, timestamps.
- `artifact_events` — append-only state/write events.
- `artifact_versions` — immutable promoted byte snapshots keyed by path + checksum + kind.

Path stays the owner-facing primary identity in V0. SHA-256 is stored beside it so content can be verified and later rematched after a move/rename without making content addressing the entire architecture.

## Plugin boundary

Server plugins live in `plugins/server/*.mjs`. A plugin may contribute:

- metadata used to create a UI tab
- a `beforeWrite()` deterministic gate
- an API `action()`

Client modules live in `public/plugins/*.js` and receive the same workbench context. The shell owns navigation, file selection, and editor state. Plugins own one focused control surface.

That is the refactor rule for Card Workshop: useful behavior becomes a removable plugin. The dashboard remains reusable.

## DeepSeek Harness direction

DeepSeek Harness already provides the right lower-level primitives: out-of-tree plugin bundles, reversible Cordis effects, append-only session events, and client slots. Research Operations should integrate through those seams rather than fork the Harness.

The current Harness does not expose a clean root-scoped third-party global-page registry, so V0 stays a separate local frontend instead of replacing the Harness `root` or `conversation` UI. Backend integrations can still be DSH plugins. When a stable global view seam exists, this dashboard shell can be mounted there without changing the control-plane model.

## Next implementation slices

1. DSH provenance adapter: bind session IDs/turns/tool calls to artifact events without copying trajectory data.
2. Configurable routing/protected-path matrix as a backend policy plugin.
3. Three-way `base / current owner head / candidate` conflict plugin.
4. Markdown span/block addressing as a plugin, not a permanent requirement of every file.
5. Statistical execution adapter that records inputs, code checksum, runtime, parameters, result artifacts, and interpretation separately.
6. Postgres promotion sink behind the same promotion event, leaving working files and local provenance intact.
