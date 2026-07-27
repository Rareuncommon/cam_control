# CamBridge

Controls Sony FX3 and FX30 bodies through a running **CamBridge** server.

## Setup

1. Start CamBridge (the app, or `./scripts/start.sh`).
2. In this connection's config, enter the address you open the CamBridge control
   panel on, and its port (8088 by default). If Companion runs on the same Mac
   as CamBridge, `127.0.0.1` is correct.
3. The status goes green once connected. Cameras appear in every dropdown
   automatically — a camera added in the CamBridge web panel shows up here
   without restarting anything.

Cameras themselves are added in the CamBridge **Setup** tab, not here.

## Presets

Drag-and-drop buttons are provided under **Record**, **Tally**, **Status**,
**Scenes**, and one category per camera for exposure and focus. They already
carry the feedbacks that make them readable, so a record button goes red on its
own.

## Actions

| Action | Notes |
|---|---|
| Record start / stop / toggle | Per camera, or all cameras at once |
| Step a value up or down | Iris, ISO, shutter, ND, Kelvin, tint, contrast, saturation, sharpness |
| Set an exact value | Snaps to the nearest legal value by default; supports variables |
| Auto / Manual | Switches iris, ISO or shutter out of Auto so it can be driven |
| Preset / scene recall | With an optional 1–8 second ramp and group filter |
| Match | Copies exposure and colour from one camera to the others |
| Camera menu key | Drives the body's own on-screen menu |
| Autofocus, focus nudge, reconnect | |

**Iris direction:** "Up" means *more light* — it walks **down** the f-number
list. This matches the − / + stepper in the CamBridge web panel, so both
controls agree about which way is brighter.

**Stepping does nothing?** If iris, ISO or shutter is on Auto, the camera
reports it read-only and a step is correctly ignored. Use the **Auto / Manual**
action first — the same thing the web panel's "Set Manual" button does.

## Feedbacks

Recording, recording FAILED, connection state, any camera down, daemon
unreachable, exposure value comparisons, "parameter is on Auto", tally
(program/preview), and link state.

`Recording FAILED` is amber rather than red on purpose: red already means
"rolling", and the two must never be confused.

## Variables

Per camera, using the camera's id with any hyphens turned into underscores —
`$(cambridge:wide_iris)`, `$(cambridge:wide_recording)`, `$(cambridge:wide_battery)`,
plus `_iso`, `_shutter`, `_kelvin`, `_wb`, `_nd`, `_media`, `_state`, `_label`,
`_model`, `_tally`.

Values are the labels the camera itself would show (`f/4.0`, `1/50`, `5600K`).
For arithmetic in expressions, `_raw` variants hold the underlying numbers:
`$(cambridge:wide_iris_raw)`.

Global: `$(cambridge:camera_count)`, `connected_count`, `recording_count`,
`cameras_down`, `daemon`, `tally_program`.

## Tally

Tally comes from CamBridge's ATEM listener, configured in `config/cambridge.json`,
not from Companion. If it is off, tally feedbacks simply stay dark.
