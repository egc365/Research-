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

Delivered ids: station `planning-board` · contribution `board-view` ·
service `board`.

Data home: `<workspace>/.research-ops/board.sqlite3` (per the data rule —
board content never enters control.sqlite3). Tables `board_groups`
(self-referencing parent_id, orientation, sort_order) and `board_cards`
(kind file|link|note, ref, sort_order), both ON DELETE CASCADE. All mutating
actions are owner-surface-only; the agent surface may only read `tree`.
