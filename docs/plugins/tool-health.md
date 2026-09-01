# tool-health

Original spec (pre-extension): the transcript-viewer "tool health" page — a board
of the machine's tool ports with up/down status, checked on demand.

Extensions deferred:
- history of checks over time (would need a content store per the data rule)
- alerting / notify on transition up→down
- reading systemd unit state alongside HTTP status

Delivered ids: station `health-monitor` · contribution `tool-health-view` ·
service `tool-health`.

Data home: none — stateless probes; probe list comes from launchpad program
defaults + workspace `links` preference + wiring config `{ targets: [...] }`.

Legacy app: tool health page inside tools/transcript-viewer (see /wiki trash as of
2026-09-01); keeps running until this plugin is accepted.
