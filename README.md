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
- Loads Governance, History, Diff, Preflight, Trajectory, Moves, Execution state, and Statistics panels through the same plugin host.
- Stores only run/span bindings for DeepSeek Harness provenance. DeepSeek's append-only session log remains the trace authority.

## V1 hardening on top of V0

- **Two surfaces, one store.** The owner surface (default `:8787`) serves the UI and honors the request actor. The agent surface (default `:8788`, `AGENT_PORT`) is API-only and forces `actor=agent` at the transport boundary, so human-only promotion is structural, not self-reported. Agents point their tools at the agent port.
- **Demotion on any content change.** Editing a `candidate` or `validated` file — through the UI or externally on disk — demotes it to `working` with a `WRITE_DEMOTION` event. Promotion can only apply to bytes the validator saw.
- **Validation receipts.** `candidate → validated` requires deterministic server-side validator receipts (the preflight policy rules run as validators); receipts record the checksum they were minted against and are refused if the bytes differ. Callers cannot supply their own receipts through the governance plugin.
- **Move detection.** A registered path missing from disk is rematched against unregistered files by checksum; accepting the remap re-keys the registry row and promoted snapshots in one transaction and appends a `MOVE` event. Owner surface only.
- **Execution state (SKILL.state, arXiv 2608.26263).** Per-run bounded structured state: agents propose JSON patches (`null` deletes a key); the runtime validates, merges (`Σ_{t+1} = Σ_t ⊕ ΔΣ_t`), and versions. Malformed or stale-version patches change nothing. Reasoning traces are never stored.
- **Statistics.** The statistics plugin reads the registry and event ledger only, never raw files.

## Run

Requires Node 22.5+ because V0 uses the built-in `node:sqlite` module.

```bash
npm test
npm start
```

Open `http://127.0.0.1:8787`, select **Add path**, and register any existing absolute folder.

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
