# cambridge — application server + web UI

Node.js service that talks to `camd` over its WebSocket API, owns all business
logic, and serves the browser control panel.

**Status: not started.** This lands in Phase 3 (event bridge + mirrored state
model) and Phase 4 (control panel). The directory exists so the shape of the
repo is settled; there is no implementation here yet, deliberately.

## What lives here when it is built

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

Single-file HTML, vanilla JS, no build step unless something genuinely demands
one. Must be usable on a laptop screen and on an iPad in landscape.

## Not architected against (Phase 6+ backlog)

Not building these yet, but nothing here should make them harder:
live view multiview, Bitfocus Companion module / satellite API, ATEM tally via
`atem-connection`, Q-SYS over Lua/TCP.
