# CACHE LANE — agent outputs as protected stock, curated back into /wiki

Date: 2026-09-01. Status: design for owner review. No code changes in this doc's track.
Source: owner's words, 2026-09-01 — "wiki outputs turns into a cache... it becomes some
protected stock. You don't even want it in the Wiki. It needs to come back into the Wiki
through a curation mechanism... it would be that one SQL, so it's trackable and you could
recover the history"; "start sending outputs to validation... then have it go to the
mirror of the project"; revision-center doctrine: rationale IN ADVANCE, historical record,
change log separated from runs, preservation rules and lint rules.

## 1. The cache root: `/curation/cache`

Proposed path: **`/curation/cache/<project-slug>/...`** — one subfolder per project,
mirroring the project's path shape inside /wiki.

Why there and not elsewhere:
- **Outside /wiki** — the owner's core requirement. Raw agent output never lands in wiki
  authority; it arrives only through the curation mechanism below.
- **`/curation` already exists in the machine's directory map** ("harvested session
  material"). No new top-level name to promote; and the owner named the return path a
  *curation* mechanism — the directory says what the lane is.
- **It is an ordinary directory**, so it registers as an ordinary workspace via
  `POST /api/workspaces` (owner surface — the owner registers it once). Everything the
  app already has then applies for free: `artifact_registry`, the `artifact_events`
  ledger, states, trash, labels, the validation queue.
- Agents reach it through the **agent surface (:8788)** with `PUT /api/file` — actor is
  stamped `agent` at the transport boundary (`enforceSurfaceActor`), never claimed.

**Doctrine note:** this supersedes the standing "default agent write lane = /wiki/outputs"
rule in global CLAUDE.md. On acceptance, that line goes stale and should be amended by the
owner; the 2026-09-01 instruction is the newer authority.

## 2. Curation return path: cache → wiki, hop by hop

/wiki is registered as a second workspace in this app (this answers V1-CONTRACT open
question 6 with **yes**). Every hop below is an existing verb except the last.

```
 agent (:8788)                                   owner (:8787)
      |                                               |
      v                                               v
 [/curation/cache/<proj>/doc.md]                 [/wiki/<proj>/doc.md]
      |                                               ^
  PUT /api/file .......... WRITE (actor=agent)        |
      |                                               |
  governance transition -> candidate                  |
      |        (snapshot per V1 D.17)                 |
  governance transition -> validated                  |
      |        (receipts, server-minted,              |
      |         pinned to one checksum)               |
  governance transition -> promoted  (OWNER ONLY) ----+
      |        bytes frozen in artifact_versions      |
      +---- governed MOVE into the wiki mirror path --+
                (the one missing verb: cross-workspace moveEntry)
```

| hop | verb | exists? |
|---|---|---|
| agent writes to cache | `PUT /api/file` on :8788 | yes |
| working → candidate | `POST /api/plugins/governance/action` `{action:'transition', toState:'candidate'}` | yes |
| candidate → validated | same, `toState:'validated'` — receipts minted by write checks, `VALIDATION_RECEIPTS_REQUIRED` otherwise | yes |
| validated → promoted | same, `toState:'promoted'`, owner surface only (`PROMOTION_REQUIRES_HUMAN_APPROVAL` is structural) | yes |
| promoted cache doc → wiki mirror path | governed move | **missing** |

**The missing piece, precisely:** `moveEntry` asserts both paths inside ONE workspace root
and never updates `artifact_registry.workspace_root`. Cache→wiki needs a
**cross-workspace `moveEntry`**: same one-transaction carry of the four path-keyed tables
(registry, path_labels, amendments, artifact_versions — the frozen promoted snapshot
travels with the file), plus re-pointing `workspace_root` to the wiki root, plus computing
the **mirror path**: `/curation/cache/<proj>/a/b.md` → `/wiki/<proj>/a/b.md` (the
project-relative path is preserved verbatim; the owner's "mirror of the project").
Owner-surface-only, like delete. **Order is fixed: promote first, then move** — promotion
freezes the exact bytes; the move carries the frozen version along.

## 3. "That one SQL" — the trackable history

`artifact_events` is the single history table. One document's whole journey:

```sql
SELECT event_id, path, event_type, from_state, to_state, actor, checksum, created_at
FROM artifact_events
WHERE path IN ('/curation/cache/projX/doc.md', '/wiki/projX/doc.md')
ORDER BY event_id;
```

returns, in order:
```
WRITE                    actor=agent      (cache path)      -- maybe several
STATE_TRANSITION  working->candidate   actor=agent
STATE_TRANSITION  candidate->validated actor=agent   metadata: validation receipts
STATE_TRANSITION  validated->promoted  actor=human
MOVE                     actor=human      (wiki path, metadata.from_path = cache path)
```
Events keep their original paths (V1 D.20 — they are history); the MOVE event links old
to new, so recovery is a two-path query, never a reconstruction. Amendments and decisions
along the way sit in `amendments` and DECISION events in the same store.

## 4. Retention: cache purgeable, wiki preserved

- A promoted document **leaves** the cache (move semantics). What remains in
  `/curation/cache` is only never-promoted residue: drafts, rejected candidates, dead ends.
- Purging that residue loses nothing authoritative, because promotion already froze the
  accepted bytes into `artifact_versions` **and** moved the live file into /wiki. The
  ledger keeps the full paper trail either way.
- Mechanics today: owner-only trash (`POST /api/fs/delete` → `.research-ops/trash`).
  Two knobs do not exist yet and are the whole retention feature: **empty-trash** and a
  **TTL sweep** for cache files still `working` after N days. TTL belongs as a future
  `policy_rules` rule type scoped to the cache root — policy, never a label side effect
  (F.27).
- /wiki side: nothing in this lane deletes from the wiki workspace. Wiki edits go through
  the same lifecycle (edit → drift → re-candidate), history intact.

## 5. Preservation rules + lint rules (revision-center doctrine)

**Preservation:** rationale is communicated IN ADVANCE — the `note` field on amendments
exists for exactly this; transitions carry `metadata`. The historical record is the ledger
plus frozen versions; the change log (STATE_TRANSITION / MOVE events) is already separate
from run traces (run_id/span_id are opaque references, never the record).

**Lint = deterministic write checks** (the existing `policy_rules` engine, run at
beforeWrite and at validation) scoped to `/curation/cache`. A document that fails lint
never becomes a candidate. Proposed rules:

1. `require_text` "# " — every cache doc opens with a markdown H1 (existing rule type).
2. `max_bytes` 5 MB — matches the read-cap red flag; oversized output is a defect
   (existing rule type).
3. `forbid_text` on known synthetic-path patterns (e.g. `/wiki/outputs/` inside a cache
   doc, `/tmp/` cited as evidence home) — no pointers into lanes this design closes
   (existing rule type; the grounded-language rule's teeth).
4. **new** `sha_citations` — every claimed quote/evidence line carrying a `sha:` locator
   must be a well-formed 64-hex sha256; malformed locators are fabrication risk.
5. **new** `note_required` — a candidate transition on cache paths is refused unless
   `metadata.note` is non-empty: the rationale, in advance, every time.
6. **new** `mirror_path_exists` — the doc's project slug must match a registered
   project folder in /wiki, so nothing is promoted toward a mirror that isn't there
   (no synthetic destination paths).
7. **new** `markdown_structure` — headings strictly nested (no h1→h3 jumps), fenced code
   blocks closed; keeps the corpus parseable by the card/block machinery.
8. `json_parse` on any `.json` in the cache (existing rule type).

New validator types (4–7) extend the same engine — one rule table, receipts in the
transition event, nothing bespoke.

## Build list (smallest honest set)

1. Owner registers `/curation/cache` and `/wiki` as workspaces (zero code).
2. Cross-workspace `moveEntry` + owner-surface endpoint with mirror-path computation.
3. `policy_rules` rows for lint 1–3, 8; new validator types 4–7.
4. Empty-trash + cache TTL rule type (retention knobs, V1.1).
