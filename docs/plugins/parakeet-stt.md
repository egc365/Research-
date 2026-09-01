# parakeet-stt

Original spec (pre-extension): the running Parakeet STT service's own HTTP API
(/apps/parakeet-stt, FastAPI on 127.0.0.1:7880 per its config.json). Routes that
actually exist in its server.py:

- `GET /` (static UI) · `GET /api/status` · `GET /api/mics` · `GET /api/config`
  · `POST /api/config`
- `POST /api/listen/start` · `POST /api/listen/stop`
- `POST /api/ptt/start` · `POST /api/ptt/stop` · `GET /api/rounds`
- `POST /api/record/start` · `POST /api/record/stop` · `GET /api/record/status`
  · `GET /api/record/list` · `POST /api/record/process` · `GET /api/record/jobs`
- `POST /api/reload` · `POST /api/transcribe` · `WS /ws`

This plugin uses only three of them: `GET /api/status` (status action, mapped to
up/down without throwing), `POST /api/listen/start` and `POST /api/listen/stop`
(owner-only toggle actions; the app's 409 `{ok:false,error}` answers are passed
through, not converted to errors). Probing is loopback-only — a non-loopback
base URL is refused with `LOOPBACK_ONLY`; the agent surface gets status but the
listen toggles throw `OWNER_SURFACE_ONLY`. `RESEARCH_OPS_PARAKEET_URL`
overrides the base URL for tests.

Extensions deferred:
- live transcript stream view (the app's `WS /ws` channel)
- injection history / rounds view (`GET /api/rounds`)
- waveform / mic level display
- recording controls (`/api/record/*`) and push-to-talk (`/api/ptt/*`)
- config editing (`POST /api/config`) and model reload (`POST /api/reload`)

Delivered ids: station `stt-monitor` · contribution `parakeet-view` ·
service `parakeet-stt`.

Data home: none — stateless probe + proxy; config summary is read live from
/apps/parakeet-stt/config.json (model_name, host, port, sample_rate,
prefer_cuda, mic fields).

Legacy app: the Parakeet web UI at http://127.0.0.1:7880/ stays authoritative
for everything beyond status and the listen toggle; healthcheck.sh remains the
accessibility-critical regression check.
