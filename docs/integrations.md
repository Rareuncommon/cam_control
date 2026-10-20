# Integrations

Ways to drive CamBridge from something other than the web panel. All are off
until switched on, and none of them is required.

| | Where it is configured | Needs hardware to confirm |
|---|---|---|
| Bitfocus Companion | in Companion | no |
| ATEM tally | `config/cambridge.json` | **yes** |
| VISCA | `config/cambridge.json` | **yes** |
| SKAARHOJ panel (PTZ) | Setup, or `config/cambridge.json` — see [skaarhoj.md](skaarhoj.md) | **yes** |
| Gamepad | in the browser | no |

PTZ cameras themselves are covered in [ptz.md](ptz.md).

---

## Bitfocus Companion

A full Companion module lives in `companion-module-cambridge/`. It gives a
Stream Deck record buttons that go red on their own, a status key per camera
(green standby, red recording, yellow on a fault or critical alarm), exposure on
physical keys, scene recall, tally, and press-and-hold control of every PTZ head.

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

If CamBridge has a PIN set, Companion needs a token (see `docs/running-the-app.md`):
paste it into the module's **Access token** field. It is a password-type field,
sent as `Authorization: Bearer <token>` on every request and the event stream,
and never logged. Without it CamBridge answers 401 and the module shows
"CamBridge needs a token — set one in the module config". The **Held-key safety
limit** option (default 15 s, 5-120 s) stops a PTZ head whose key release was lost.

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

### PTZ cameras

**A selected camera.** One Stream Deck page drives any number of heads, the way a
hardware PTZ controller does. "PTZ: select camera" picks one: a camera, a bank
slot, or next/previous, optionally within a group. Every PTZ action can target
**(selected camera)**, which is the default for new buttons. The
`ptz_selected_*` variables show the selected head's state.

**Banks.** The **PTZ controller** preset page has eight camera keys (the bank
size is configurable), bank next/previous, the 8-way pad, zoom, focus, home, AF,
tracking, presets 1–8 and STOP ALL — all acting on the selected camera. A camera
key shows tally ahead of "selected": on air matters more.

**Press and hold.** Pan, tilt, zoom and focus keys move while held and stop on
release. The module refreshes the move every 150 ms so CamBridge's deadman keeps
it alive. If Companion stops or loses CamBridge, the head stops within half a
second. A key whose release never arrives is stopped after the hold ceiling
(15 s by default, configurable).

**Set any setting** offers every ordinary setting on the camera, from its own
table. Admin settings — network, users, firmware — are not offered.

**Big venues:** the module option "Ready-made buttons for every PTZ camera" can
be turned off; the controller page covers every camera through banks.

The full list of actions, feedbacks and variables is in the module's own help
(`companion-module-cambridge/companion/HELP.md`).

### Two things worth knowing

**Iris direction.** "Up" means *more light*, which walks **down** the f-number
list. Same as the − / + stepper in the web panel, deliberately.

**A step that does nothing** is almost always a parameter on Auto. In Flexible
Exposure the camera reports iris/ISO/shutter read-only until you take them off
Auto, and the module refuses to write rather than pretending. Use the **Auto /
Manual** action first.

### Version

Built against `@companion-module/base` **1.14.x**, which Bitfocus lists as
targeting **Companion 4.2 or newer**, as required by its API 1.14.1 runtime.
Enter a configured CamBridge API token when PIN protection is enabled.

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
mid-take.

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

## ATEM Link — drive Sony cameras from a Blackmagic panel

Turns the switcher's camera control into Sony property writes, so a hardware
shading panel — or the Camera page in ATEM Software Control — moves iris, gain,
white balance, shutter and focus on the FX3 and FX30s.

**Still switcher-to-camera only.** CamBridge does not gain the ability to send
the switcher anything; the read-only guarantee above is unchanged.

Every write goes through the same path as one made in the browser, so a move
made on the panel is logged, gang-aware and undoable.

### Set it up in two passes, not one

The Blackmagic *payload* format is published and is what the mapping below is
built on. The way an ATEM *wraps* it in its own packets is community
reverse-engineering, and has not been confirmed against real hardware here. So
Link ships off, and there is a capture mode for confirming it in one sitting.

**Pass one — look.**

```json
"atem": { "enabled": true, "host": "172.16.16.10",
          "mapping": { "cam1": 1, "cam2": 2, "cam3": 3 },
          "link": false, "logRaw": true }
```

Restart, then move **one control at a time** on the panel and watch
`cambridge.log`:

```
INFO [atem-link] CCdP dest=2 0.3 type=128 values=[0.62]  raw: 02 00 03 00 80 00 00 01 04 f6
```

Check three things: `dest` matches the input you moved, the `category.parameter`
matches the control (the table below), and `values` moves the way the control
does. If they line up, the layout is right. If they do not, that log line is
exactly what is needed to correct `WRAPPER` in `cambridge/src/atem-cc.js` — one
line of offsets, not a rewrite.

**Pass two — switch it on.** Set `"link": true` and leave `logRaw` off.

### What maps

| Panel control | Blackmagic id | Sony |
|---|---|---|
| Iris | 0.3 aperture, normalised | `fNumber` |
| Focus | 0.0 | `focusPosition` |
| Auto focus | 0.1 | AF trigger |
| Zoom | 0.8 | `zoomPosition` |
| White balance | 1.2 kelvin + tint | `colorTemp`, `wbTint` |
| Shutter | 1.5 exposure µs | `shutterSpeed` |
| Gain | 1.13 dB | `isoSensitivity` |
| ISO | 1.14 | `isoSensitivity` |

Iris walks the body's own aperture list by position rather than being scaled
arithmetically. Blackmagic's normalised aperture is linear in aperture *area*,
so a straight conversion would make the top of the panel's travel do almost
nothing and the bottom jump several stops. Walking the list keeps one detent on
the panel worth one step on the camera.

**Colour correction wheels are deliberately not mapped.** Blackmagic's model is
a lift/gamma/gain wheel per channel; Sony's Creative Look is a handful of scalar
trims. There is no faithful conversion, and an approximate one would shift the
look of a camera that is on air in a way nobody asked for. Turning those wheels
logs a reason at debug level rather than doing nothing silently.

Relative adjustments are refused for the same reason: the panel's idea of a step
is not the camera's.

### If a control does nothing

Run at `"level": "debug"` and look for `atem-link` lines. Each says which camera
and which control, and why it was ignored — "iris is not writable, it is
probably on Auto" is the common one, and is fixed on the camera with
**Set Manual** in the panel, not here.

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

**On the cinema bodies, pan, tilt and zoom are refused**, with a VISCA "not
executable" error rather than silence. They have no motorised head; a controller
that is told so shows the operator the axis does nothing, instead of leaving them
pushing a stick and wondering.

Every command goes through the same path as a change made in the browser, so it
is logged and gang-aware.

### PTZ heads

For PTZ heads the common VISCA subset is forwarded to the head's own driver:
pan/tilt drive, home, zoom and focus (variable or standard speed), focus
auto/manual, one-push AF, and preset recall. Most heads speak VISCA themselves;
this earns its place because the Canon does not, and because one controller then
drives every head through the same deadman and logging as the panel.

Motion from a controller is held safely:

- **Over TCP**, a move lasts until the controller sends its stop, and is
  released the moment its connection closes. A pulled cable closes nothing, so
  it also lapses after `tcpHoldMs` (default 60 s) unless the controller repeats
  it, and TCP keepalive notices a dead controller sooner where the OS allows.
- **Over UDP** there is no connection to watch, so a move is held for
  `udpHoldMs` (default 10 s) unless the controller repeats it.

Messages are taken whole and in order, however TCP splits or merges them. A stop
goes to the camera its move went to, even if the camera order changed in
between.

```json
"visca": {
  "enabled": true,
  "port": 52381,
  "allow": ["192.0.2.40", "192.0.2.64/28"],
  "cameraPorts": { "stage-left": 52401, "stage-right": 52402 },
  "allowPresetStore": false,
  "udpHoldMs": 10000
}
```

| Option | Does |
|---|---|
| `allow` | controller addresses (or blocks) that may send commands. VISCA carries no credentials and the PIN does not apply to it, so set this; empty accepts any host, and says so in the log |
| `cameraPorts` | a port per camera. A VISCA address is three bits, so the shared port can tell at most seven cameras apart — and VISCA-over-IP controllers choose a camera by IP and port anyway. Add CamBridge to the controller once per camera, at this machine's address and that camera's port |
| `allowPresetStore` | lets a controller store over or delete a head's own presets. Off by default; recall always works |
| `udpHoldMs` | how long a UDP controller's move lasts without a repeat |
| `tcpHoldMs` | the same for a TCP controller (default 60000), in case its link dies without closing |

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
the panel at the start of a shoot.

Which camera the sticks drive is shown on its card with a 🎮 badge, and picked in
the gamepad dialog or with the shoulder buttons.

Whether "up" on the focus stick is nearer or further depends on the lens; that
one is worth checking on your own glass.
