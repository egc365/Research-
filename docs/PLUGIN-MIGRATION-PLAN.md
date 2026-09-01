# Plugin migration plan — orphan apps into Research Operations

Date: 2026-09-01. Status: proposal for owner review; tool-health is delivered as the
worked example. Answers the owner's questions from the 2026-09-01 session.

## Does making everything a plugin hurt or help when we recode?

**Help.** Three properties of the composition system make plugins the safe lane for
"weed out and uncollapse" work:

1. **Owner state survives recodes.** What is enabled where lives in SQLite
   (`ui_plugins.enabled`, `workspace_plugins`, `station_contributions`), and boot
   deliberately never overwrites it (`syncCatalog` preserves enabled flags; wiring
   is seeded only when a station has zero rows). Rewriting a plugin's code changes
   nothing about where the owner mounted it.
2. **Retirement is clean.** `retired[]` in `plugins/registry.mjs` removes a dead
   plugin from all three composition tables at boot — no ghosts, so an experiment
   that fails is deleted without residue.
3. **Content never lives in composition tables** (store.mjs composition comment).
   A plugin's data has its own home, so recoding the UI or service cannot corrupt
   accumulated content.

The one real cost: a plugin gets the kernel's frame (workspace scoping, slots,
actor-split surfaces) whether it wants it or not. An app that is genuinely
machine-global rather than per-workspace (gpu-governor) mounts the same way but
should ignore `rootPath` — that is fine, the launchpad already links machine-global
programs.

## Naming convention (the "add X plugin, strip extensions" schema)

Same schema we already use, made explicit. Every incoming app becomes up to three
kebab-case ids:

| kind | id pattern | example |
|---|---|---|
| station | the tool's name | `health-monitor`, `transcript-review` |
| contribution | `<name>-view` (or the behavior's name) | `tool-health-view`, `card-rail` |
| service | the capability's name | `tool-health`, `transcript-search` |

Rules already enforced by code: ids are `[a-z0-9-]`, unique across all kinds
(`catalogRows` throws on collision — a station and its service cannot share an id).

**Intake law per app:** before coding, write `docs/plugins/<slug>.md` with exactly
these sections, so the strip-down is recorded and the extensions are parked, not lost:

```
# <slug>
Original spec (pre-extension): what the first working version did, sourced from
  the session transcripts / the running legacy app — not from memory.
Extensions deferred: every idea that accreted later (e.g. trace logic on
  transcript search), each one line, each a future contribution or config flag.
Delivered ids: station / contributions / services.
Data home: where content lives (see data rule).
Legacy app: port + path of the version being replaced; it keeps running until
  the plugin is accepted.
```

## Data rule for plugins that store content

`control.sqlite3` stays routing and configuration only. A plugin that accumulates
content (search index, Q/A packets, transcript blocks) gets its **own SQLite file**:

- per-workspace content → `<workspace>/.research-ops/<slug>.sqlite3`
  (the trash precedent — already excluded from the tree and from walks);
- machine-global content (transcripts, GPU history) → the plugin's service opens
  its existing store read-only where one exists (e.g. the transcript catalog),
  rather than copying it.

## The roster

| plugin | verdict | notes |
|---|---|---|
| **tool-health / port-health** | ✅ delivered | `health-monitor` station, `tool-health-view` contribution, `tool-health` service (loopback-only server-side probes). Probe list = launchpad programs + workspace `links` pref + wiring config. |
| **transcript-review** | yes — next | Strip to the pre-trace spec: deep search over transcripts (bot → session → evidence-kind filters, date range, per-page). Trace logic and live-overlay become *deferred extensions* (later contributions). Service opens the existing transcript stores read-only. Source the original spec from the fable session transcripts, not recall. |
| **search-engine** | yes (owner's call confirmed by the data rule) | Per-workspace FTS index in `<root>/.research-ops/search.sqlite3`, rebuilt incrementally from WRITE events; a sidebar search contribution + a results station. Navigable as it grows because the index is per-workspace, not global. |
| **rag-review + block-retrieval** | yes — as a *recomposition*, not a port | The v1 was "not done correctly"; the end state (searchable RAG preserving question + answer packets) recycles what already exists: `dual-document-view`, `diff-renderer`, `card-rail`, `decision-controls`, `promotion-control` are contributions today. New parts: a `qa-packets` service + store (packet = question, answer, sources, verdict) and a packet-rail contribution. The :8841 sheet UI is the reference for what to keep. |
| **gpu-governor** | yes, thin | Station + view over the existing governor's state; actions (limits) owner-surface-only like promotion. The governor process itself stays outside the app. |
| **parakeet / stt-monitor** | yes, thin | Same shape as tool-health: a service that reads the STT app's status endpoint + a view. The app keeps its own port; the plugin is the window, not the process. |

Recycling is the point of the last column: promotion/curation ideas from the older
apps (Image #6 lineage) come back as wiring choices, not rewrites.

## The dashboard error note ("tmp cache?")

No cache needed. The red `ENOENT: scandir` footer was a raw filesystem error
escaping from a ghost workspace registration (folder trashed, `workspace_roots` row
left behind). Fixed structurally on 2026-09-01: registrations now follow the folder
through governed move/trash, `listWorkspaces` reports `exists`, missing roots get a
labeled frame with an unregister button, and the error is a coded
`WORKSPACE_ROOT_MISSING` instead of ENOENT. State lives in SQLite; nothing about
this wants a tmp cache.
