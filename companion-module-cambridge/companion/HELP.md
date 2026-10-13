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

## PTZ cameras

PTZ heads (Panasonic, Sony, Canon, PTZOptics) appear in the PTZ actions only. Pan/tilt, zoom and focus are **press-and-hold**: put the move action on button down and **PTZ: release** on button up (the ready-made buttons already do). While held the module refreshes the move every 150 ms; CamBridge stops the head itself if refreshes stop. Also: preset recall/store, STOP ALL, tracking, home, one-push AF and **PTZ: set any setting**, whose choices come from each camera. Variables `$(cambridge:<id>_pan|_tilt|_zoom|_preset|_tracking|_moving)`; feedbacks tracking, preset is current, moving. At a PTZ-only venue `$(cambridge:daemon)` reads "not used".

### Many PTZ cameras: the selected camera and banks

One page can drive any number of heads, like a hardware PTZ controller. **PTZ: select camera** picks a camera, a slot of the current bank, or next/previous (optionally within a group). Every PTZ action and feedback offers **(selected camera)** as its camera, and it is the default for new buttons. The selection belongs to this module instance only; it survives camera-list changes that keep the head, and moving it while a key is held stops the old head first.

The **PTZ controller** button category has a row of camera-select keys for the current bank (tally, selected and offline feedbacks), bank next/previous, the direction pad, zoom and focus, presets 1-8, home, AF, tracking and STOP ALL, all on the selected camera. **PTZ: camera bank next / previous / go to** pages the select keys. Set the bank size (default 8) in the module config.

Variables: `$(cambridge:ptz_selected)`, `ptz_selected_label`, `ptz_selected_group`, `ptz_selected_state`, `ptz_selected_tally`, `ptz_selected_pan|_tilt|_zoom|_preset|_tracking|_moving`, `ptz_bank`, `ptz_bank_count`, `ptz_bank_slot_N_label`. Feedbacks: camera is selected, bank slot is selected / on air / not connected.

At a big venue, untick **Ready-made buttons for every PTZ camera** in the module config: the per-camera button categories (hundreds of buttons) go away and the controller page covers every head. Camera dropdowns list cameras in CamBridge's order as `Name (group)`.
