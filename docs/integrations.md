# Integrations

Four ways to drive CamBridge from something other than the web panel. All are
off until switched on, and none of them is required.

| | Where it is configured | Needs hardware to confirm |
|---|---|---|
| Bitfocus Companion | in Companion | no |
| ATEM tally | `config/cambridge.json` | **yes** |
| VISCA | `config/cambridge.json` | **yes** |
| Gamepad | in the browser | no |

---

## Bitfocus Companion

A full Companion module lives in `companion-module-cambridge/`. It gives a
Stream Deck record buttons that go red on their own, exposure on physical keys,
scene recall, and tally.

### Installing

```sh
cd companion-module-cambridge
npm install
```

Then in Companion: **Settings → Developer modules path**, point it at the
directory *containing* `companion-module-cambridge`, and restart Companion. The
module appears as **cambridge** when you add a connection.

Configure it with the address you open the CamBridge panel on, and its port
(8088). If Companion runs on the same Mac as CamBridge, `127.0.0.1` is right.

### What it gives you

**Ready-made buttons** under Record, Tally, Status, Scenes, and one category per
camera — drag them onto a page and they work, feedbacks included.

**Actions:** record start/stop/toggle per camera or all at once; step iris, ISO,
shutter, ND, Kelvin, tint, contrast, saturation, sharpness; set an exact value;
switch a parameter between Auto and Manual; recall and save presets and scenes,
with the same ramp and group filtering the web panel has; match; link; camera
menu keys; autofocus, focus nudge, reconnect.

**Feedbacks:** recording, recording FAILED, connection state, any camera down,
daemon unreachable, value comparisons, "parameter is on Auto", tally, link
state.

**Variables:** per camera `$(cambridge:wide_iris)`, `_iso`, `_shutter`,
`_kelvin`, `_wb`, `_nd`, `_battery`, `_media`, `_state`, `_recording`, `_tally`,
plus `_raw` variants for expressions. Global: `camera_count`,
`connected_count`, `recording_count`, `cameras_down`, `daemon`, `tally_program`.

Values are the labels the camera itself shows — `f/4.0`, not `400`.

### Two things worth knowing

**Iris direction.** "Up" means *more light*, which walks **down** the f-number
list. Same as the − / + stepper in the web panel, deliberately.

**A step that does nothing** is almost always a parameter on Auto. In Flexible
Exposure the camera reports iris/ISO/shutter read-only until you take them off
Auto, and the module refuses to write rather than pretending. Use the **Auto /
Manual** action first.

### Version

Built against `@companion-module/base` **1.14.x**, which Bitfocus lists as
compatible with every Companion from **3.0 to 4.3**. The 2.x SDK only supports
4.3 and is marked unconfirmed, so 1.x is the safer target.

---

## ATEM tally

Shows which camera is live. On the control panel a program camera gets a red
border and an **ON AIR** badge; preview gets green. Multiview tiles get the same
treatment, and Companion gets a `tally` feedback and a `_tally` variable.

```json
"atem": {
  "enabled": true,
  "host": "172.16.16.10",
  "port": 9910,
  "mapping": { "cam1": 1, "cam2": 2, "cam3": 3 }
}
```

`mapping` is which ATEM input each camera is plugged into, numbered as on the
switcher.

**This is read-only.** CamBridge completes the ATEM handshake and then only
listens. It never sends a switcher command, so no bug here can cut a source
mid-service.

If the switcher goes quiet for five seconds the connection is torn down and
tally is cleared. Stale tally is worse than none — a red light on a camera that
is no longer live is how someone walks in front of the shot that is.

### What still needs a real switcher

The parser is tested against hand-built packets, including both tally formats
(`TlIn` and `TlSr`), malformed blocks and unknown blocks. What that cannot prove
is that *your* ATEM sends those exact bytes. Model-specific differences are
possible, particularly around which tally command a given model prefers.

If tally does not light, run cambridge with `"level": "debug"` and look for
`atem` lines: "ATEM connected" without any `tally` lines means the handshake
worked but the tally blocks were not what we expect — that is the case to report.

---

## VISCA

Lets a hardware joystick, a controller panel, or Companion's generic VISCA
module drive the cameras.

```json
"visca": {
  "enabled": true,
  "bind": "0.0.0.0",
  "port": 52381,
  "tcp": true,
  "mapping": { "cam1": 1, "cam2": 2, "cam3": 3 }
}
```

`mapping` gives each camera a VISCA address. Leave it out entirely and addresses
follow camera order, which is what you want with one camera.

Both VISCA-over-IP (the 8-byte header) and raw VISCA over TCP are accepted —
controllers differ, and it costs nothing to take either.

| VISCA command | Does |
|---|---|
| `CAM_Iris` up / down / direct | Iris. Up opens the lens |
| `CAM_Gain` up / down | ISO |
| `CAM_Shutter` up / down | Shutter |
| `CAM_WB` | White balance mode |
| `CAM_Focus` near / far / direct | Focus, as a relative nudge |
| `CAM_Focus` one-push | Autofocus |
| `CAM_Memory` set / recall | Saves and recalls a CamBridge preset named `visca-<n>` |
| Iris / gain / shutter / focus / WB inquiries | Answered from live state |

**Pan, tilt and zoom are refused**, with a VISCA "not executable" error rather
than silence. These are cinema bodies with no motorised head; a controller that
is told so shows the operator the axis does nothing, instead of leaving them
pushing a stick and wondering.

Every command goes through the same path as a change made in the browser, so it
is logged and gang-aware.

### What still needs real hardware

The server is tested with real VISCA frames over real sockets — a UDP and a TCP
client drive actual cameras in the test — so the protocol handling is proven.
What is not proven is which subset *your* controller sends. Vendors vary, and a
joystick sending a variant this does not recognise will get a syntax error back.
Turn on debug logging and look at `visca` lines to see what arrived.

---

## Gamepad

Any USB or Bluetooth controller the browser recognises. The 🎮 button appears in
the header only once a pad is detected.

| Control | Does |
|---|---|
| Left stick ↕ | Iris — up is more light |
| Left stick ↔ | Colour temperature |
| Right stick ↕ | Focus |
| Right stick ↔ | ISO |
| A / ✕ | Record the selected camera |
| B / ○ | Autofocus |
| Shoulders | Previous / next camera |
| Start | Record all / stop all |

Push a stick further to move faster — roughly one step a second just past the
deadzone, up to five a second at full deflection.

**Control is off until you switch it on**, and off again on every page load. A
controller left plugged in over the week cannot move a camera when someone opens
the panel on Sunday morning.

Which camera the sticks drive is shown on its card with a 🎮 badge, and picked in
the gamepad dialog or with the shoulder buttons.

Whether "up" on the focus stick is nearer or further depends on the lens; that
one is worth checking on your own glass.
