# board

Original spec (owner dictation, 2026-09-01): the card workshop unwound — sticky
notes that are REAL files, arranged in lanes that nest three deep; a lane lays
its children out horizontally for parallel work (kanban-like columns) or
vertically for serial execution order and writes nothing to disk; a folder card
is a real folder, open it to drill into its surface, breadcrumb back out. Cards
may also be links or plain notes.

Extensions deferred:
- connector lines between cards (dependency arrows)
- execution-JSON export (a vertical group as a runnable serial plan)
- copy-queue / clipboard intake (paste paths to mint cards)
- timeline view over the same content

Delivered ids: station `planning-board` · contribution `board-view` ·
service `board`.

Data home: `<workspace>/.research-ops/board.sqlite3` (per the data rule —
board content never enters control.sqlite3). Tables `board_lanes` (surface,
self-referencing parent_lane_id, name, orientation, sort_order) and
`board_cards` (surface, lane_id or null for the floor, kind
file|folder|link|note, ref, title, color, face, icon, fields_json, width,
sort_order), both ON DELETE CASCADE. The rules both stores obey live once in
`public/contrib/lib/board-rules.js`. All mutating actions are
owner-surface-only; the agent surface may only read `tree`.
