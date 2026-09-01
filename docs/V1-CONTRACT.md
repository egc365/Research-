# RESEARCH OPERATIONS — V1 FREEZE (architecture grill verdicts)

2026-09-01 · branch `feature/composable-ui-v1` · reviewed against the code as of
this document's commit, `/apps/revision-center` (:8880), the Card Workshop
identity behaviors, the DeepSeek Harness slot model, and the owner's
state-management review (SHA/versioning/labels/project-id questions) and the
2026-09-01 screenshot feedback (metadata strip, split view, cards-as-plugin).

Format per question: DECISION · RATIONALE · IMPLEMENTATION CONSEQUENCE · TEST.
CONFLICT lines mark where the current build disagrees with the decision; every
CONFLICT maps to an item in artifact 6 (implementation queue).

---

## A. SYSTEM BOUNDARY

**1. Kernel ownership.**
DECISION: KEEP the listed set, add nothing.
RATIONALE: The kernel today owns exactly: workspace registry UI, plugin
catalog/manager, workspace↔plugin composition, slot renderer + mount→dispose
lifecycle, selected workspace/file/card, active station, event bus + service
routing, status line, dirty-guard veto. Every screen with a name arrives as a
plugin; the custom-station feature proves stations need no code.
CONSEQUENCE: `public/kernel.js` stays the only file allowed to touch
`#stage`, `#stationBar`, `#workspaceSelect`. Nothing else is added to it.
TEST: delete every row in `workspace_plugins` for a workspace → the app still
renders the empty frame, the workspace picker, and the plugin manager.

**2. Empty-shell invariant.**
DECISION: KEEP. `A workspace with every optional plugin disabled remains a
valid usable shell.`
RATIONALE: Implemented and tested ("a fresh workspace has zero enabled
plugins — the empty frame"). Minimum mandatory set = kernel chrome only.
CONSEQUENCE: no station may ever become mandatory.
TEST: existing composition test; keep it green forever.

**3. Station / Contribution / Service.**
DECISION: KEEP, with these frozen definitions.
- **Station** — a named full-screen composition: one layout, named slots,
  wiring rows. Zero executable code of its own. If your feature is "a screen,"
  it is a station and you build it by wiring.
- **Contribution** — one mountable behavior: `export function mount(el, ctx)`,
  talks only through `ctx` (bus, services, selection). If your feature renders
  inside a screen, it is a contribution.
- **Service** — server-side capability exposing `action()` (and optionally
  `beforeWrite`/`validate`). No UI. If your feature computes, stores, or
  proxies, it is a service.
CONSEQUENCE: classification rule is mechanical; a PR adding a "component"
that is none of the three is rejected.
TEST: `defineStation` + wiring alone produces a working new screen (covered
by the owner-defined-stations test).

**4. Sub-plugins.**
DECISION: REMOVE the concept; prohibited.
RATIONALE: One level is enough: contributions mount into station slots,
period. Contributions never mount contributions. Variation is carried by
`config_json` on the wiring row (card-rail's `source` proves the pattern).
CONSEQUENCE: any need for "a card feature" becomes a config key on card-rail
or a sibling contribution in the same slot — never a nested registry.
TEST: grep the client for a contribution importing another contribution:
only `contrib/lib/*` (pure libraries) may be imported.

## B. SQLITE CROSSWALK

**5. SQLite as authoritative composition crosswalk.**
DECISION: KEEP.
Minimum tables (all exist): `ui_plugins(plugin_id PK, plugin_kind, manifest_json,
enabled)`, `workspace_plugins(workspace_root+plugin_id PK, enabled, sort_order,
config_json)`, `station_contributions(station_id+slot_name+contribution_id PK,
sort_order, config_json, enabled)`, plus `workspace_roots`.
CONSEQUENCE: no YAML/JSON composition files; `plugins/registry.mjs` is seed
data only — the DB is authority after first boot.
TEST: rewire a station via `/api/composition/station`, restart the unit, the
edit survives (covered).

**6. SQLite vs code.**
DECISION: KEEP; frozen: **SQLite holds which/where/ordered-how/configured-how
(rows + config JSON). Code holds how (algorithms, rendering, storage).**
"revision-center uses card-rail in slot side with source=transcript" is a row;
the LCS block alignment is `lib/blocks.js`.
TEST: changing a station's composition requires zero code changes (custom
station test covers it).

**7. Dependencies.**
DECISION: CHANGE — add optional `manifest.requires: [serviceId]` on
contributions; the kernel checks the catalog at mount and, when unmet, mounts
an honest "`<label>` needs the `<service>` service, which is not available"
card instead of the module.
RATIONALE: today a missing service surfaces as a failed fetch on first action
— late and cryptic. One manifest field, no dependency table: real dependencies
here are contribution→service only.
CONSEQUENCE: registry entries for dual-document-view, diff-renderer,
card-rail gain `requires: ['revision']`; kernel gains ~6 lines. Queue item.
TEST: disable the `revision` service row → revision center renders the
unavailable card, nothing throws.

**8. Precedence/override.**
DECISION: DEFER. V1 resolution is flat and deterministic: station wiring is
global; a workspace only chooses which stations are enabled.
`workspace_plugins.config_json` stays as the future workspace-override seam
and is otherwise unused.
TEST: two workspaces enabling the same station render identical wiring.

## C. WORKSPACES / PROJECTS / FILESYSTEM

**9. Workspace.**
DECISION: KEEP, frozen: **registered filesystem root + composition profile
(its workspace_plugins rows) + metadata (label)**. Nothing else.
TEST: workspace A `[validation-center]` vs B `[dashboard-viewer,
revision-center]` — both survive a unit restart (proven live 2026-09-01).

**10. Project.**
DECISION: KEEP the owner's simple intent: **a project is an ordinary folder
designated by the owner** — implemented as a folder carrying the `project`
label. No projects table, no new concept. Fixed stations of the machine
(extraction, embeddings, ontology, validation, models, venvs) are projects in
exactly this sense: configured once, then used.
CONSEQUENCE: project-create-form's only extra duty is assigning the `project`
label to the folder it makes. Queue item (one line).
TEST: label a folder `project` → it appears in any project-filtered view.

**11. Owner operations.**
DECISION: CHANGE — the required set is create workspace, register root,
create folder, create file, **rename**, move, **delete (trash)**, label,
open, edit. Delete shipped 2026-09-01 as governed move-to-trash
(`.research-ops/trash`, rows follow, state archived, owner surface only).
Rename is missing as a distinct gesture: it is `moveEntry` to the same
directory; the tree needs a rename action.
CONFLICT: no rename button in the tree today. Queue item.
TEST: rename a labeled candidate file → same registry row at the new path,
labels intact, RENAME visible as a MOVE event.

**12. Owner-controlled ordering.**
DECISION: DEFER. Alphabetical, directories first, stays for V1.
TEST: n/a (deferred; revisit only if the owner asks again).

**13. Ignore rules.**
DECISION: KEEP current truth and freeze it: tree listing and move scans share
one hardcoded exclusion, `.research-ops` (which now also hides the trash).
Configurable ignore lists, indexing and retrieval scopes: DEFER — no
speculative rule type.
TEST: `.research-ops` never appears in `/api/tree` at any depth (covered).

## D. IDENTITY, SHA, VERSIONING

**14. Roles.**
DECISION: KEEP, frozen — no two mean the same thing:
- **path** — the artifact's identity, owner-facing.
- **content SHA-256 (checksum)** — fingerprint of the exact current bytes;
  machine verification, never identity.
- **revision** — ordinal N in one card's append-only amendment log.
- **snapshot** — a durable `artifact_versions` row (kind promoted|snapshot)
  freezing bytes at a lifecycle moment.
- **project identifier** — deferred (E.21); today: folder + `project` label.
- **run ID / span ID** — opaque references into the agent harness's own logs;
  stored, never minted here.

**15. Path as owner-facing identity.**
DECISION: KEEP.
RATIONALE: Challenged: content-addressed identity dies on the first edit;
UUID identity means a lookup table between the owner and every file they
name. Path is what the owner types, sees, and greps; the registry's PK is
path; `moveEntry`/`deleteEntry` carry identity across renames in one
transaction. The Card Workshop's content-addressed ids survive where they
belong: card identity (a block's id retires when its text changes), not file
identity.
TEST: move a promoted file → same state, same promoted checksum, new path,
MOVE event (covered).

**16. Checksum vs revision.**
DECISION: KEEP the split the owner's state review was reaching for, now named:
**every save computes the current checksum** (registry column, cheap, always
true) — **durable history is only minted at meaningful transitions**
(snapshots, events, amendment revs). A keystroke never creates version
identity; a promotion always does.
CONSEQUENCE: nothing to build — this is the current design; the terminology
table (artifact 4) makes it official.
TEST: ten consecutive saves add zero `artifact_versions` rows; one promotion
adds exactly one.

**17. Durable-history triggers.**
DECISION: CHANGE — exact triggers: **promotion** (kind='promoted', exists) and
**candidate creation** (kind='snapshot', new). Explicit Save updates the
checksum only. Amendments are durable in their own table already. Validation
records receipts in the event, not bytes (the candidate snapshot already holds
the bytes it certifies). Manual snapshot: DEFER.
RATIONALE: a candidate snapshot preserves what was submitted for review even
after a demoting edit — the review conversation keeps its referent.
CONFLICT: today only promotion writes a version row. Queue item (uses the
existing table and kind, zero new schema).
TEST: submit candidate → edit file → the snapshot still returns the submitted
bytes by checksum.

**18. Human-facing SHA display.**
DECISION: CHANGE — humans see the first 12 characters with a copy-full
action; machines always exchange the full 64.
CONFLICT: the provenance card currently wraps a full SHA over three lines
(owner screenshot, 2026-09-01). Fixed by document-properties (F.28/G.29).
TEST: no default view renders more than 12 SHA characters.

**19. SHA as primary key.**
DECISION: KEEP the current answer: **nowhere**. Path is PK;
`artifact_versions` is UNIQUE(path, checksum, kind). Checksums verify,
paths identify.
TEST: schema inspection — no table keyed on checksum alone.

**20. Rename/move continuity.**
DECISION: KEEP. One transaction updates the four path-keyed tables
(registry, path_labels, amendments, artifact_versions) by exact path and, for
directories, by prefix — no tree rescans, disk rolled back on failure. History
events keep their original paths (they are history); the MOVE/DELETE event
links old to new.
TEST: covered (`moveEntry`/`deleteEntry` tests).

## E. PROJECT IDS

**21. Human-readable project IDs (PROJ-2026-017).**
DECISION: DEFER from V1; the seam is frozen: a project is a folder with the
`project` label, so IDs are one table away (`project_ids(id PK, path, minted_at)`,
minted when the label is assigned, immutable, displayed beside the folder
name). Owner question 1 decides whether V1.1 builds it.
RATIONALE: no aggregation consumer exists yet; minting IDs with no reader is
ceremony.
TEST (if built): assigning `project` twice to the same folder mints one ID.

**22. What gets human-readable IDs.**
DECISION: KEEP it minimal: amendment revs (rev 1..N — exists), and possibly
projects (deferred). Candidates, runs, research questions: no new IDs — runs
keep harness ids, candidates are path+state+checksum.
TEST: no ID-generation code outside amendment revs (and the deferred
project seam).

## F. LABELS

**23. Purpose.**
DECISION: KEEP — V1 labels are **human classification and retrieval filter**.
Agents read them, never write them. Not routing, not policy.

**24. Tables.**
DECISION: KEEP `labels(name PK, color, description)` +
`path_labels(path+label PK, workspace_root, actor)`. Correct and tested.

**25. Files and folders.**
DECISION: KEEP — both, implemented and tested (assign, cascade delete,
rename carrying designations, rows following moves and trash).

**26. Hierarchy.**
DECISION: DEFER. Flat names in V1; `evidence`/`primary-source` are two labels.

**27. Magical labels.**
DECISION: REMOVE the possibility — frozen: **labels never trigger behavior.**
Policy lives in `policy_rules`; classification lives in labels; the two never
meet in V1. A future `protected` behavior would be a policy rule scoped to a
path, not a label side effect.
TEST: grep server code for reads of `path_labels` outside the labels API —
must be none.

**28. Label interaction.**
DECISION: KEEP the shipped model, frozen: tree 🏷 / Labels… on the selected
object → dialog (assign/remove with zero path typing, create, rename,
recolor, describe, delete with counts, advanced typed-path field). No
permanent screen space; disabling label-editor removes the UI, data survives.
Display of assigned labels moves into the document-properties strip (G.29)
and stays as tree chips.

## G. FILE WORKBENCH

**29. Responsibility + the owner's screenshot verdicts (2026-09-01).**
DECISION: CHANGE. File Workbench = ordinary authoring: edit, save
(checksum-guarded), continuous comparison, and a **document-properties strip
at the BOTTOM of the document, collapsed behind a Properties toggle** — path,
state badge, sha-12 + copy, labels (with a shortcut to the label dialog),
updated, run/span when present. It communicates what the SQL row says and
updates live on bus events. The half-page keyval rail is rejected (owner,
image 13). The editing layout follows :8880 (owner, image 14): tree left,
**split document center** (editor | preserved), cards right as an optional
plugin — "cards should be a plug in feature so we stop bolting them on".
What belongs elsewhere: verdicts (Revision Center), lifecycle authorization
(Validation Center).
CONFLICT: current file-workbench default wiring stacks state-badge +
provenance-block + timeline in a side rail. Queue items 1–2 replace it:
new `document-properties` contribution (merges state-badge display +
provenance-block + labels into the bottom strip) and rewired defaults.
TEST: open a file → one collapsed Properties strip at the bottom; expanding
shows state/sha12/labels/updated; recording a decision or save updates it
without reload.

**30. Shared components.**
DECISION: KEEP — File Workbench, Revision Center and Validation Center mount
the same diff-renderer, dual-document-view, document-properties modules via
wiring rows. No exceptions exist and none are permitted.
TEST: `ls public/contrib` — one file per behavior (verified: one diff
implementation, `lib/blocks.js`).

**31. Editable formats.**
DECISION: KEEP current truth, frozen: **any UTF-8 text is editable** —
markdown gets block rendering/cards, JSON/YAML/source edit as plain text (a
`json_parse` policy rule already validates JSON on write where scoped).
**Binary is read-refused with an honest sentence** (revision service does
this today). Syntax highlighting: DEFER.
TEST: covered ("unsupported and missing files answer honestly").

## H. REVISION CENTER

**32. :8880 behaviors in the plugin version.**
Preserved/new dual view — KEEP (ported, aligned blocks, markdown-rendered).
Original document — KEEP. Session transcript — KEEP (proxied). Cards — KEEP.
Actor filtering (All/Owner/Agent/Wrote this file/Open) — KEEP. Open card —
KEEP (select → amendment/decision contributions). Where-it-came-from — KEEP
(jumps the dual view to the transcript event). Amendments — KEEP (append-only
rev N+1, in THIS app's store). Revision history per card — KEEP. Accept —
KEEP. Needs-more-work — KEEP. Guarded-file behavior (no decisions on
owner-kept files) — CHANGE: not ported; :8880 keeps it for /wiki; this app's
equivalent protection is a `deny_write` policy rule. Session picker when
several sessions touched a file — CHANGE: today only the dual view's
transcript tab picks; the card rail pins the first session. Queue item.

**33. revision-service.**
DECISION: KEEP, frozen surface: `open(path, preferBase)` →
base/working/supported/hasBase; `sessions(path)`; `cards(session, path)`;
`events(session, path)`. Transcript data proxied read-only from :8880,
degrading to `{[], note}` when unreachable. Amendments/decisions go through
the core API into this app's store — the UI never learns where records live,
and `/apps/revision-center/state` is never written.
TEST: covered (adapter tests run with :8880 pointed at a dead port).

**34. Amendment vs file edit vs revision.**
DECISION: KEEP, frozen:
- **file edit** — governed write; changes working bytes; updates checksum;
  never touches history tables.
- **amendment** — append-only proposal against one card; never touches the
  file; each save is **rev** N+1 for that (path, card).
- **snapshot** — durable frozen bytes in `artifact_versions` (D.17).
The word "revision" is reserved for amendment revs (terminology table).

**35. Card as generic primitive.**
DECISION: KEEP — frozen normalized schema (what card-rail renders):
`{ id, actor, kind, n, text, line?, ts?, sha?, tags[], wrote?, status
(latest decision), rev (latest amendment) }`. Sources are wiring config:
`blocks` (document), `transcript` (:8880 proxy), and — queue —
`registry` (validation queue), which retires candidate-list's bespoke wall.
CONFLICT: candidate-list is a separate card-like implementation ("no more
recoding" — owner). Queue item: card-rail grows the `registry` source;
candidate-list retires.

## I. VALIDATION / PROMOTION

**36. Terminology.** KEEP — station `Validation Center`; the word **Promote**
appears exactly once in the UI (validated → promoted). Shipped.

**37. Candidate** — an artifact whose current exact checksum has been
submitted for review (state `candidate`; snapshot minted per D.17).

**38. Validated** — the deterministic write-check rules passed against that
exact checksum; receipts recorded in the transition event. Server-minted,
never caller-supplied.

**39. Promoted** — a human authorized the validated checksum as authority;
bytes frozen in `artifact_versions`; any later byte change shows as drift and
demotes to working.

**40. One-checksum invariant.**
DECISION: KEEP — `Validation applies to one exact content checksum.`
Implemented: receipts carry the checksum; editing after validation demotes
(proven live); editing after promotion shows drift by SHA pair.
TEST: covered (demote-on-edit acceptance).

**41. Actual validators.**
DECISION: KEEP the engine, CHANGE the words. The deterministic rules that
exist: `deny_write`, `max_bytes`, `require_text`, `forbid_text`,
`json_parse` — scoped by path in `policy_rules`, run on every write
(beforeWrite) and at validation (validate). The UI word "Preflight" is
jargon; rename visible text to **write checks**. The service id stays.
CONFLICT: UI says "Preflight"/"policy rules". Queue item (wording only).

**42. Default Validation Center view.** KEEP — the workspace-level queue card
wall (candidates and validated first, both SHAs, drift badge). Shipped.

**43. Editing in Validation Center.**
DECISION: KEEP the expected answer: no. Challenged: allowing "one quick fix"
inline would silently invalidate the receipt being looked at. It routes:
Open in Revision Center / File Workbench (shipped, with the
unenabled-station guard).
TEST: no editor contribution may appear in validation-center wiring.

**44. Human authorization boundary.**
DECISION: KEEP, frozen (= authority matrix, artifact 5): ordinary filesystem
work and candidate/validation — either actor (agent stamped at transport).
Human-only: promotion, decisions, policy mutation, labels, composition,
workspace/station definition, delete (trash). Destructive beyond trash: not
in the app at all.

## J. AUTH / OWNER ACTION

**45. Authentication model.**
DECISION: KEEP — the requirement is already met: there is no token anywhere,
no per-Promote ceremony. The model is loopback binding (127.0.0.1) plus the
owner/agent surface split. Session unlock: DEFER until the app is ever
exposed beyond loopback.
TEST: promote via the owner UI involves exactly one click and zero prompts.

**46. Two ports.**
DECISION: KEEP — on architecture, not inertia: `enforceSurfaceActor` rewrites
the actor at the transport boundary, so "agent cannot claim human" is a
property of the socket, not of request contents; it is covered by seven
surface tests. A capability-token scheme would reimplement the same guarantee
with more moving parts and a secret to manage.
TEST: existing http-surfaces suite is the contract.

**47. Automated promotion seam.**
DECISION: DEFER implementation; freeze the seam: a future `policy_rules` row
(rule_type `auto_promote`, scoped path, explicit owner-written conditions)
evaluated by the deterministic runtime, recording actor
`policy:<rule_id>` — never `human`. The transition guard changes from
"actor === 'human'" to "human or policy-authorized" only when that rule type
ships.
TEST (future): auto-promoted event's actor names the rule, and the owner UI
shows it as policy, not person.

## K. PROVENANCE / REPORTING BURDEN

**48. Source of truth.**
DECISION: KEEP — harness transcripts (via :8880's index) stay where they are,
referenced by session id and jsonl path, proxied read-only, never copied.
This app's own truth is its ledger: `artifact_events` + `amendments` +
`artifact_versions`, with run/span as opaque foreign references.

**49. Human-visible provenance by default.**
DECISION: CHANGE — by default: state badge, sha-12, updated, labels (the
properties strip). Full ledger, actor filters, run/span detail live in the
provenance viewer and timeline, opened on purpose. ID flooding removed with
the side rail (G.29).

**50. Agent report tax.**
DECISION: KEEP the structural answer and say it out loud: **the ledger is the
report.** WRITE/MKDIR/MOVE/DELETE/TRANSITION/DECISION events with actor,
checksum and receipts replace narrative completion reports for everything
this app governs. An agent that wrote a file and submitted a candidate has
already reported by doing it.

**51. Minimum audit event set.**
DECISION: KEEP, frozen: REGISTER, WRITE, MKDIR, MOVE, DELETE,
STATE_TRANSITION (with from/to, checksum, receipts), DECISION — plus the
amendments table. Reconstruction = ledger + versions + amendments. No other
event types without a new grill.

## L. EXECUTION STATE

**52. Placement.**
DECISION: CHANGE — service yes, station no. The execution-state station
exposes plumbing the owner does not operate; retire it from the shipped
stations. The service (versioned SKILL.state store) and the
execution-state-view contribution stay in the catalog for wiring into a
custom station when wanted.
CONFLICT: station currently shipped. Queue item (add to `retired`).

**53. What the owner sees.** Run id, state version and updated time, in the
timeline/provenance views, only when a run touched the selected file. Raw
JSON only inside the optional contribution.

**54. Lifecycle.** KEEP current: state lives per run_id with optimistic
version checks; reset = new run id; no auto-expiry in V1.

## M. DASHBOARD

**55. Optional.** KEEP — yes; it is a station like any other.

**56. Hard-coded cards.** KEEP the expected answer — none exist: the
dashboard is one wiring row (statistics-view). It stays that way.

**57/58. Default content.**
DECISION: CHANGE — minimal per owner intent: counts by state (validation
queue pressure) + most recent activity, both from the ledger, nothing else by
default. Start-project and recent-files are contributions the owner wires in
if wanted; statistics-view is trimmed to counts+recent.
CONFLICT: statistics-view currently also renders event/actor breakdowns by
default. Queue item (trim; the fuller breakdown stays behind a toggle).

## N. PLUGIN MANAGER

**59. Workspace-specific composition.** KEEP — yes (proven: A vs B).
**60. Actions.** KEEP: available, enabled, enable, disable, wire/unwire,
＋ New station. Configure = editing a wiring row's config; a form for it is
DEFERred (config is JSON in the DB today, editable via API).
**61. Live effect.** KEEP — recompose without restart (shipped).
**62. Data on disable.** KEEP — registrations disappear, durable data
remains: proven for labels (label-editor off → chips' data intact) and by the
retirement mechanism (rows leave composition tables; content tables
untouched).

## O. ORPHAN DISPOSITION

| Feature | Disposition |
|---|---|
| old Governance UI | REMOVED (done); `governance` stays a SERVICE |
| History | SERVICE (`history`) + CONTRIBUTION (`revision-timeline`); no station |
| Diff | CONTRIBUTION (`diff-renderer`); legacy line-diff SERVICE kept for agents/tests |
| Preflight | SERVICE; UI wording becomes "write checks" |
| Execution State | SERVICE + optional CONTRIBUTION; station RETIRED (queue) |
| Provenance | CONTRIBUTION set: `document-properties` (default) + `provenance-block`/timeline in provenance-viewer station |
| Moves | SERVICE (`moves` scan) + core governed move/trash |
| Statistics | SERVICE + CONTRIBUTION (trimmed default) |
| Labels | CONTRIBUTION (`label-editor`) + core tables |
| Editor | CONTRIBUTION (`markdown-editor`) |
| File tree | CONTRIBUTION (`filesystem-tree`) |

## P. CONTRIBUTION CATALOG (V1 freeze)

| Contribution | Verdict |
|---|---|
| filesystem-tree | KEEP (tree, create, rename[queue], move, trash, chips, Labels…) |
| markdown-editor | KEEP |
| dual-document-view | KEEP (modes; config.base) |
| diff-renderer | KEEP (the one diff) |
| card-rail | KEEP + CHANGE (third source `registry`; absorbs candidate-list) |
| actor-filter | KEEP |
| amendment-editor | KEEP |
| revision-timeline | KEEP |
| decision-controls | KEEP |
| provenance-block | MERGE → `document-properties` (bottom strip); block form survives only in provenance-viewer wiring |
| validation-result | KEEP |
| promotion-control | KEEP (label "Validation controls"; sole home of Promote) |
| label-editor (= label-manager) | KEEP — canonical name `label-editor` |
| state-badge | MERGE → `document-properties`; retire standalone after queue item 1 |
| project-create-form | KEEP (+ assigns `project` label) |
| candidate-list | MERGE → card-rail source `registry` (queue) |
| statistics-view | KEEP (trimmed default) |
| execution-state-view | KEEP in catalog; unwired by default |

Duplicates identified: state-badge/provenance-block (→ document-properties),
candidate-list (→ card-rail). No duplicate diff, provenance renderer, or
card implementation may exist after the queue completes.

## Q. PERFORMANCE / SAFETY

**63. Forbidden during ordinary render:** recursive tree scans (tree loads
one directory per expand — keep), whole-workspace hashing (none exists — keep
it so), corpus-wide statistics (statistics reads the ledger only), transcript
ingestion (owned by :8880's background indexer; this app only proxies).

**64. Explicit background jobs:** transcript indexing (:8880's), move scans
(on demand via the moves service). Nothing else in V1.

**65. Cache/index instead of recompute:** the ledger IS the index (counts,
recents); path_labels per workspace is one indexed query per paint — fine.
Session lists per file: proxied, not cached — acceptable at V1 scale; DEFER
caching.

**66. Synchronous paths that can freeze :8787 — RED FLAGS:**
1. `execFileSync` git calls in `plugins/server/revision.mjs` block the event
   loop per request. Fix: async `execFile`. Queue item.
2. `/api/file` and revision `open` read whole files with no size cap; a
   multi-GB file freezes the server. Fix: refuse > 5 MB with an honest note.
   Queue item.
3. `node:sqlite` is synchronous by design — accepted: queries are indexed and
   small.

---

# R. FREEZE ARTIFACTS

## 1. V1 FEATURE MATRIX

| Feature | Type | Verdict | Owner-facing purpose | Backend dependency |
|---|---|---|---|---|
| Kernel (frame, plugin manager, lifecycle, bus) | Kernel | KEEP | the shell everything mounts into | store composition tables |
| file-workbench | Station | CHANGE (split view + properties strip) | authoring | revision, governance, registry |
| revision-center | Station | KEEP | review/amend/decide over documents | revision (+ :8880 proxy) |
| validation-center | Station | KEEP | queue → inspect → validate → Promote | governance, registry, revision |
| dashboard-viewer | Station | CHANGE (trim default) | counts + recent | statistics |
| provenance-viewer | Station | KEEP | full ledger on purpose | history |
| project-creator | Station | KEEP | start a project folder | core write path |
| execution-state | Station | REMOVE (retire; service stays) | — | execution |
| custom stations | Station | KEEP | owner-composed screens | none |
| contributions (per §P) | Contribution | per §P | — | per manifest.requires |
| governance, registry, revision, diff, history, preflight, moves, statistics, execution, trajectory | Service | KEEP | — | store |
| labels + path_labels | Kernel data | KEEP | classification | — |
| amendments + decisions | Kernel data | KEEP | append-only review record | — |
| trash (delete) | Kernel op | KEEP (new) | reversible delete | store |

## 2. FINAL SQLITE RELATIONSHIP MODEL (V1 — no speculative tables)

```
workspace_roots (root_path PK)
  ├─ artifact_registry   (path PK, workspace_root FK, state, checksum, promoted_checksum, run/span)
  │    ├─ artifact_events   (path, event_type, from/to_state, checksum, actor, run/span, metadata)
  │    └─ artifact_versions (path, checksum, kind promoted|snapshot, content)  UNIQUE(path,checksum,kind)
  ├─ path_labels         (path+label PK, workspace_root, actor) ── labels (name PK, color, description)
  └─ workspace_plugins   (workspace_root+plugin_id PK, enabled, sort_order, config_json)
ui_plugins (plugin_id PK, kind station|contribution|service, manifest_json, enabled)
  └─ station_contributions (station_id+slot_name+contribution_id PK, sort_order, config_json, enabled)
amendments  (path, card, rev  UNIQUE(path,card,rev), body, note, actor, sha256)
policy_rules (scope_path, rule_type deny_write|max_bytes|require_text|forbid_text|json_parse, rule_json, enabled)
execution_state (run_id PK, state_json, state_version)
```

## 3. FINAL PLUGIN GRAPH (V1 nodes)

```
Workspace
 └─ enabled stations (workspace_plugins)
     file-workbench      rail[filesystem-tree, label-editor]
                         main[markdown-editor | dual-document-view (split)]
                         side[card-rail(source=blocks) optional]
                         bottom-of-main[document-properties]
     revision-center     rail[filesystem-tree]
                         main[dual-document-view(base=auto)]
                         side[card-rail(source=transcript), amendment-editor,
                              decision-controls, revision-timeline]
     validation-center   rail[card-rail(source=registry)]
                         main[dual-document-view(base=promoted),
                              diff-renderer(base=promoted), validation-result]
                         side[document-properties, promotion-control,
                              open-in via document-properties]
     dashboard-viewer    main[statistics-view(trimmed)]
     provenance-viewer   rail[filesystem-tree] main[revision-timeline]
                         side[actor-filter, provenance-block]
     project-creator     main[project-create-form]
     <owner-defined>     any slots ← any contributions
Services: revision · governance · registry · diff · history · preflight
          · moves · statistics · execution · trajectory
```

## 4. TERMINOLOGY (frozen)

| Term | Meaning |
|---|---|
| Workspace | registered filesystem root + composition profile + label |
| Project | a folder the owner designated with the `project` label |
| Artifact | a file registered in `artifact_registry` under a workspace root |
| Path | the artifact's identity, owner-facing |
| Checksum | SHA-256 of the current exact bytes; verification, not identity; humans see 12 chars |
| Revision | ordinal N in one card's append-only amendment log |
| Snapshot | durable frozen bytes in `artifact_versions` (minted at candidate + promotion) |
| Candidate | artifact whose exact checksum is submitted for review |
| Validated | write checks passed at that exact checksum; receipts recorded |
| Promoted | human-authorized authority bytes, frozen |
| Label | owner classification on a file or folder; never behavior |
| Station | full-screen composition; wiring rows, zero code |
| Contribution | one mountable behavior, coded once |
| Service | server capability with actions, no UI |
| Run / Span | opaque references into the agent harness's own logs |

## 5. AUTHORITY MATRIX

| Operation | Owner | Agent (:8788) | Deterministic runtime |
|---|---|---|---|
| read files/tree/labels/composition | ✓ | ✓ | ✓ |
| write file (governed) | ✓ | ✓ (actor stamped) | — |
| create folder / move | ✓ | ✓ (stamped) | — |
| rename | ✓ | ✓ (stamped; = move) | — |
| delete (trash) | ✓ | ✗ 403 | — |
| label define/assign | ✓ | ✗ 403 | — |
| submit candidate | ✓ | ✓ | — |
| validate | ✓ | ✓ | receipts minted by write checks only |
| **promote** | ✓ | ✗ structural | future: policy rule, actor `policy:<id>` |
| decisions (accept / needs-more-work) | ✓ | ✗ 403 | — |
| amendments | ✓ | ✓ (stamped) | — |
| policy mutation | ✓ | ✗ 403 | — |
| composition / station definition / workspaces | ✓ | ✗ 403 | — |
| archive (via trash) | ✓ | ✗ | — |

## 6. REMAINING IMPLEMENTATION QUEUE (dependency order, one Fable pass each)

1. **document-properties contribution** — bottom strip, collapsed Properties
   toggle: path, state, sha-12+copy, labels + Labels… shortcut, updated,
   run/span, open-in buttons; live on bus events. Retire state-badge +
   provenance-block from default wiring (both stay in catalog for
   provenance-viewer).
2. **File Workbench split view** — rewire per artifact 3 (image 14 layout):
   editor | preserved split in main, card-rail optional in side, properties
   at bottom. Wiring + small editor/dual coordination.
3. **card-rail `registry` source** — the validation queue as cards;
   candidate-list retires (catalog + wiring).
4. **async revision service** — `execFile` instead of `execFileSync`; 5 MB
   read cap on `/api/file` and revision `open` with honest refusal.
5. **rename in the tree** — prompt + `/api/fs/move` to same directory.
6. **snapshot at candidate creation** — `artifact_versions` kind='snapshot'
   in the governance transition.
7. **manifest.requires** — kernel mounts honest unavailable card.
8. **wording pass** — "Preflight"→"write checks" in UI text; retire
   execution-state station (add to `retired`).
9. **statistics-view trim** — counts + recent by default, breakdowns behind
   a toggle.
10. **card session picker** — card-rail offers the session list when several
    sessions touched the file (parity with :8880).

## 7. RED FLAGS (do not carry forward)

- `execFileSync` git calls inside HTTP request handling (revision service) —
  event-loop blocker. (queue 4)
- Unbounded whole-file reads on `/api/file` and revision `open`. (queue 4)
- Full 64-char SHAs rendered in default UI. (queue 1)
- candidate-list as a second card implementation. (queue 3)
- `deleteEntry` sets `archived` outside `allowedTransitions` — DECIDED
  exception, not a bug: trash is not a lifecycle transition; the DELETE event
  is its record. Do not "fix" it into a transition.
- Native `prompt()`/`confirm()` for names and trash — functional, inconsistent
  with the dialog language elsewhere; acceptable V1, replace opportunistically.
- localStorage tree-expansion keys accumulate per workspace forever — harmless
  at this scale; note only.

## 8. OPEN QUESTIONS FOR OWNER (preference only)

1. **Project IDs:** when a folder gets the `project` label, should V1.1 mint
   an immutable `PROJ-2026-NNN` shown beside its name (one small table), or
   do paths + the label stay sufficient?
2. **Candidate snapshots:** freezing bytes at candidate submission (queue 6)
   doubles stored copies for reviewed files. Worth it, or promotion-only
   snapshots?
3. **Dashboard default:** counts + most-recent-activity only — or fully empty
   until you wire it yourself?
4. **Card look:** :8880 renders cards light-on-dark (your screenshot); keep
   that look in the port, or match the app's dark cards?
5. **Agent labels:** labels are owner-only writes today. Should agents ever
   get a separate, visually distinct `machine:` label namespace for
   classification they compute, or stay read-only?
6. **/wiki in this app:** keep /wiki registered as a workspace here (tree +
   revision center over it), or keep /wiki review exclusively at :8880?
7. **Trash retention:** leave `.research-ops/trash` to accumulate until you
   empty it by hand, or add a Trash view with restore/empty in V1.1?
8. **Split-view default:** in File Workbench, should the split's right pane
   default to the preserved version (git/promoted) or to the rendered preview
   of what you are editing?

---

After the owner answers artifact 8, this document is the frozen V1 contract;
implementation proceeds strictly from artifact 6.

---

# ADDENDUM 2026-09-01 — NOTION-STYLE WORKSPACE FLOW + APPEARANCE (owner spec)

Decided and building in this sequence; supersedes conflicting lines above.

- **Shell**: the kernel owns a collapsible, drag-resizable left sidebar; its
  content is plugin sections from `sidebar_sections` rows (visible /
  collapsed / ordered per workspace; headless sections carry dialogs). The
  workspace switcher lives in the sidebar head. Station rails are retired —
  navigation is the sidebar; stations are main+side.
- **Three configs, kept separate**: composition = what a workspace can do
  (`workspace_plugins` + wiring); appearance = what it looks like
  (`workspace_ui_preferences` / `user_ui_preferences`, validated JSON, tokens
  only); navigation = how it is organized (`sidebar_sections`, favorites,
  manual order in preferences). Plugin enable/disable is independent of
  appearance (acceptance 11).
- **Design tokens**: one `:root` layer (background, surface, surface-alt,
  border, text, muted-text, accent, success, warning, danger, spacing,
  radius, font-size, editor-font-size + derived tints). Light theme is a
  token override; density/radius/accent/font prefs retune tokens. Plugins
  never ship their own themes.
- **Sidebar sections shipped**: Favorites (starred paths in preferences),
  Projects (folders labeled `project`), Files (the same filesystem-tree
  contribution), Recent (ledger), Trash (with restore), label-editor
  (headless). All are catalog contributions; show/hide/reorder in Customize.
- **Manual ordering**: per-directory name order in preferences key `order`;
  never forced back to alphabetical once the owner has ordered a folder.
  Same-parent drag = reorder; cross-parent drag = move (unchanged).
- **Dashboard = link hub**: launchpad (stations, workspaces, machine
  programs :7860/:7861/:7870/:8860/:8880 + per-workspace links), folder
  cards (Notion-style card view of the root or a configured folder), inbox
  (candidates/validated awaiting the owner + recent), statistics. All
  wiring; per-workspace content comes from per-workspace data, and any
  workspace can define its own dashboard as a custom station.
- **Workspace management**: rename + emoji icon + **Remove workspace** in
  Customize → Workspace (unregisters everything in one transaction; the
  folder and files stay on disk). Trash restore ships (rows and labels come
  back; lifecycle state re-earned as `working`).
- **Customize workspace** dialog: Workspace / Appearance (live preview,
  user-scope apply-everywhere, reset) / Sidebar / Dashboard / Plugins.
- **Mini-plugins stay mini** (owner): fine-grained contributions are the
  point — dual-document-view, diff-renderer etc. remain separately
  toggleable behaviors; nothing gets merged into monoliths.
