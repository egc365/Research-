# gpu-governor

Original spec (pre-extension): the running `gpu_governor.py` dashboard on
http://127.0.0.1:7890 — the systemd daemon that polls nvidia-smi, matches GPU
processes against the owner allowlist, and TERMs anything not allowed or over
its cap, logging every action.

Read-only v1: the governor process itself stays outside the app (the plugin is
the window, not the process — see docs/PLUGIN-MIGRATION-PLAN.md roster). The
`status` action reads the daemon's data files defensively (torn/missing files
degrade to nulls) and links out to the :7890 dashboard for the enforcement
verbs (STOP, STOP-ALL, pause).

Extensions deferred:
- mutating limit changes (editing allowlist rules / budget) — owner-only
- alerting / notify on kill events
- history charts of GPU usage over time (would need a content store per the
  data rule)

Delivered ids: station `gpu-monitor` · contribution `gpu-governor-view` ·
service `gpu-governor`.

Data home: the governor's own files under `/apps/gpu-governor` —
`latest.json` (current snapshot, rewritten each poll), `events.jsonl`
(append-only enforcement log; only the tail is read, limit default 20, cap
200). The allowlist is being repointed from `/wiki/config/gpu-allowlist.json`
to `/apps/gpu-governor/config/gpu-allowlist.json`: the new path is tried
FIRST, the legacy path is the fallback, and the response reports which path
was found (`allowlistPath` / `allowlistSource`). Env overrides for tests:
`RESEARCH_OPS_GPU_GOVERNOR_DIR` (base dir, default `/apps/gpu-governor`) and
`RESEARCH_OPS_GPU_ALLOWLIST` (legacy fallback path).

Legacy app: the daemon's own dashboard at :7890 keeps running — it stays the
enforcement surface; this plugin never mutates governor state.
