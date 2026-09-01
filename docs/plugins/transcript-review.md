# transcript-review

Original spec (pre-extension), sourced from the trashed live viewer
(`/wiki/.research-ops/trash/*-tools/transcript-viewer/README.md`, accepted
2026-08-15): block review where "provider is a bot cutover, not an empty text
box" — pick a bot, that cuts the session list to that provider, then filter
blocks by kind, role, date range, per page. Five native roots, read-only:
Claude `~/.claude/projects`, Codex `~/.codex/sessions`,
DeepSeek `/Ai-workshop/deepseek/home/sessions`, Grok `~/.grok/sessions`,
Kimi `~/.kimi-code/sessions`. Provider logs stay authoritative; the viewer
never rewrites them.

Extensions deferred (each a future contribution or service action):
- trace logic / work-trace + team-subagent evidence layers (post-spec accretion)
- live overlay + refresh pulse (`/investigate`)
- one-page shell sheet per session (`/sheet/{chat_id}`)
- DeepSeek compressed event-log decoding (v1 lists `.jsonl` only)
- FTS index over the whole corpus (belongs to the search-engine plugin; v1
  unindexed scans are bounded to the newest 12 sessions per provider)
- candidate preparation / tool deck

Delivered ids: station `transcript-review` · contribution
`transcript-search-view` · service `transcript-search`.

Data home: none — stateless read-only scans of the native roots
(`RESEARCH_OPS_TRANSCRIPT_ROOTS` overrides for tests).

Legacy app: transcript viewer on `127.0.0.1:8841`
(`transcript-review-8841.service`, running from now-trashed
`/wiki/tools/transcript-viewer`); keeps running until this plugin is accepted.
