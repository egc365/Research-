# board

Original spec (owner dictation, 2026-09-01): the card workshop unwound — sticky
notes that are REAL files, arranged in groups and subgroups; a group lays its
children out horizontally for hierarchy (kanban-like columns) or vertically for
serial execution order; drill into a group, breadcrumb back out. Cards may also
be links or plain notes.

Extensions deferred:
- connector lines between cards (dependency arrows)
- execution-JSON export (a vertical group as a runnable serial plan)
- copy-queue / clipboard intake (paste paths to mint cards)
- timeline view over the same content

Delivered ids: station `dashboard-viewer` · contribution `board-view` (the
`board` source of `public/contrib/card-view.js`, with `whiteboard-view` in
memory) · service `board`.

Data home: `<workspace>/.research-ops/board.sqlite3` (per the data rule —
board content never enters control.sqlite3). Tables `board_lanes` (surface,
self-referencing parent_lane_id, name, slug, orientation, x, y, w for a top-level lane's place on the canvas, run_id once the lane has been run, sort_order) and
`board_cards` (surface, lane_id or null for the floor, kind
file|folder|link|note, ref, title, color, face, icon, fields_json, width,
sort_order), both ON DELETE CASCADE. The rules both stores obey live once in
`public/contrib/lib/board-rules.js`. All mutating actions are
owner-surface-only; the agent surface may only read `tree` and `lane-run-state`.

A lane runs. `run-lane { surface, laneId }` seeds an execution-state run
(service `execution`, control.sqlite3) whose state is the lane's plan:
`{ board: { surface, lane: <slug> }, steps: [{ card, kind, status }...], step }`,
the lane's own cards first, then each child lane's cards depth-first, in
canvas order. A lane with no cards refuses to run (`Nothing to run`). The lane
row keeps only the run id; `lane-run-state { surface, laneId }` reads
`{ laneId, runId, step, total }` from the state for the header counter, and the
counter opens the Execution state station on that run
(`activateStation('execution-state', { run })`, carried in the URL as `run=`).
A second `run-lane` returns the existing run. The whiteboard refuses both.
