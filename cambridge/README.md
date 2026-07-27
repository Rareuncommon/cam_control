# cambridge — application server + web UI

Node.js service that talks to `camd` over its WebSocket API, owns all business
logic, and serves the browser control panel.

**Status: built.** Phases 3–5. Zero npm dependencies — Node 22's built-in
WebSocket client talks to camd, and the browser is fed by Server-Sent Events, so
there is no install step before a shoot and nothing to break on a Node upgrade.

```sh
node src/server.js --config ../config/cambridge.json
npm test        # 27 tests, no install required
```

## What lives here

- Multi-camera state model, mirrored from `camd` events
- Normalisation across bodies — the FX30 is Super 35 and the FX3 is full-frame,
  so base ISO and some ranges differ. `camd` reports raw SDK values; converting
  those into something a human can compare across three cameras is this layer's
  job.
- Presets (per-camera exposure + WB snapshots) and scenes (all three at once)
- Gang control with per-camera offsets
- Match mode — copy exposure/WB from a reference body to the others
- Rotating state-change log

## Frontend

`public/index.html` — one file, vanilla JS, no build step. Dark by default
because it runs in a dim booth. Three cameras fit an iPad in landscape without
scrolling; controls are sized for a finger, not just a mouse.

The recording indicator is driven from the camera's own `RecordingState`, never
from "we sent the command" — including the `Recording_Failed` case, which shows
a banner rather than a calm red dot.

## Not architected against (Phase 6+ backlog)

Not building these yet, but nothing here should make them harder:
live view multiview, Bitfocus Companion module / satellite API, ATEM tally via
`atem-connection`, Q-SYS over Lua/TCP.
