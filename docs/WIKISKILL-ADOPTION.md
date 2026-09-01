# WikiSkill adoption — grounding the loop this machine already runs

Date: 2026-09-01. Sources (owner-supplied via Drive, 2026-09-01):
- **WikiSkill** — arXiv 2608.27454, "WikiSkill: Compiling Agent Experience into
  Persistent Knowledge for Skill Evolution" (Tang, Rashtchian, Ferng, Tomkins,
  Juan, Vu). Three-stage cycle: (1) execution & trace collection, (2) wiki
  consolidation of experience into persistent knowledge, (3) skill refinement
  built on that knowledge. Key ablation: persistent accumulation in the wiki is
  critical; evolved skills transfer across models.
- **SKILL.state** — arXiv 2608.26263, "Scalable Long-Horizon Agent Skills". The
  ΔΣ state-patch inner loop. Already implemented here: `execution_state` table +
  `applyStatePatch` in src/store.mjs, surfaced by the execution-state station.

## The mapping — paper stage → what this machine already has

| WikiSkill stage | here | store |
|---|---|---|
| 1. Execution & trace collection | every bot's native session logs, read-only via the transcript-search service; harvested spans under /curation | provider-native roots; /curation/transcripts |
| 2. Wiki consolidation | the curation return path: cache workspace → candidate → validated (receipts) → owner promotes into /wiki (docs/CACHE-LANE.md); revision center amendments carry rationale in advance | artifact_registry + artifact_events (the "one SQL" history); /wiki authority |
| 3. Skill refinement | skills and plugins built FROM consolidated wiki knowledge — the per-plugin intake docs (original spec sourced from transcripts, extensions parked) are exactly "compiled experience" | docs/plugins/*.md; ~/.claude/skills; SKILL.state runs via execution-state |

## What adopting the paper's workflow changes in practice

1. **Traces are raw material, never authority.** Stage 1 stays read-only (already
   enforced: transcript-search never writes provider logs).
2. **Consolidation is the bottleneck the paper says to invest in.** The cache lane
   (CACHE-LANE.md) is the consolidation mechanism: nothing enters /wiki except
   through validation + human promotion, and every hop is one artifact_events row.
   This is the "persistent knowledge accumulation" the ablations call critical.
3. **Skills are compiled, not drafted from memory.** A new skill/plugin starts from
   consolidated wiki evidence — the intake-doc rule ("original spec sourced from
   the session transcripts, not recall") is the compile step. Deferred-extension
   lists are the refinement backlog for the next cycle.
4. **The cycle repeats.** Each round of this app's own development (bug → transcript
   evidence → plan doc → plugin → intake doc) is one WikiSkill iteration run on
   itself.
