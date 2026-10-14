# PTZ cameras

CamBridge drives PTZ heads alongside — or instead of — the FX3/FX30 bodies:

| Make | Model built for | Protocol | Also accepts |
|---|---|---|---|
| Panasonic | AW-UE160 | HTTP CGI (integrated camera interface) | other AW-UE / AW-HE / AW-UN heads |
| Sony | BRC-AM7 | VISCA over IP + CGI | other Sony remote cameras (BRC, SRG, FR7) |
| Canon | CR-N500 | XC protocol (HTTP) | other Canon XC heads (CR-N300, CR-N700, CR-X300…) |
| PTZOptics | Move SE | raw VISCA over TCP 5678 + HTTP CGI | other PTZOptics heads (Move 4K, Link, Studio, G2/G3) |

Each camera shows its own features, not a lowest common denominator. Auto
Framing appears on the BRC-AM7 because that camera has it, and on nothing else.

**Other models from the same makes** are accepted with the closest table. Every
setting is marked *not yet confirmed on this model*, and anything the camera
refuses to answer is hidden rather than shown broken. Run `ptz-report.sh` (below)
on a new model to see what it really answers.

---

## A venue with only PTZ heads

There is nothing to build or install beyond Node.js. With no Sony bodies in the
config, CamBridge runs without camd — no Sony SDK, no daemon, and no
"daemon offline" banner. The launchers (`start.sh`, the app) decide this from
the config themselves, and on the very first run, before any camera is added,
they start without camd when it is not built. The first run also creates the
config, so a new Mac needs no editing: see the
[short path in install.md](install.md#ptz-heads-only-the-short-path).

A Sony BRC-AM7 or FR7 is also a Sony SDK camera. Add it here, as a PTZ head;
Setup then shows it as already added if camd discovers it too, so it is never
controlled two ways at once.

## Adding cameras

**Setup → Add a PTZ camera.** Give the IP (or host name), the camera's username
and password, optionally the make. **Find camera** asks the address what it is
— read-only, nothing moves — and shows the model. Name it and **Add**.

**Many at once: Setup → Add many PTZ cameras.** Paste addresses — a list, a range
(`192.0.2.10-29`), a small block (`192.0.2.0/27`) or host names — with the one
set of credentials the integrator put on all of them, and optionally a group.
**Find cameras** probes each address and lists what answered; **Add all found**
adds them.

Credentials only ever go to addresses you typed; CamBridge never scans the
network on its own. During a bulk find, Basic authentication is never sent,
because it carries the password in the clear to whatever device asks for it.

Adding cameras needs the admin PIN, because it stores camera credentials.

### Groups and order

Give cameras a **group** ("Stage", "Balcony") in their Edit dialog, and put them
in order with ▲ / ▼. The order is the same everywhere: the panel, multiview,
Companion, the SKAARHOJ camera buttons and VISCA addresses.

## The panel

**Up to four heads:** one full card each — joystick, zoom and focus rails, AF,
presets, the camera's own exposure and colour controls, and tracking where the
camera has it.

**More than four:** a **camera bus** — one compact tile per head, showing name,
group, tally, connection, a moving dot, tracking and current preset — and one
full panel for the selected head. Tap a tile, or press **1–9 / 0** or **← / →**,
to select. Riders of two or four heads at once can choose 2-up or 4-up. Layout
(Auto / All cards / Bus) and the group filter are remembered per browser.

**Settings** opens everything the camera's web page offers, grouped the way that
page groups it, with a search box. Settings that change the network, users,
firmware or reboot the camera are in an **Admin** section. They need the admin
PIN and the camera's name typed back, and they are refused while that camera is
on air.

**Presets** are the camera's own, so Reactor, the camera's web page and
CamBridge all recall the same ones. CamBridge adds a name and a picture of the
shot when you store one from here.

**STOP ALL PTZ** in the top bar stops every head. If a head's stop could not be
confirmed — its link dropped mid-move — the panel names it. That head may still
be moving.

**Multiview** shows every head. Tapping the picture aims the camera at that
point where the camera supports it. With many tiles the frame rate per tile drops
so the total stays bounded, and tiles scrolled out of view stop fetching.

### The gamepad

In the bus layout the gamepad drives the selected head: left stick pan/tilt,
right stick zoom (up/down) and focus (left/right), B for one-push AF. Changing
the selection stops the old head, and the new one does not move until the sticks
have come back to centre.

## SKAARHOJ and Reactor

Reactor keeps driving the cameras by default; CamBridge follows whatever it
changes. CamBridge can drive the PTZ Extreme instead — see
[skaarhoj.md](skaarhoj.md), including camera banks for more cameras than the
panel has buttons.

## Companion

See [integrations.md](integrations.md#bitfocus-companion). In short: a
**selected camera** with camera banks and a ready-made **PTZ controller** page,
so one Stream Deck page drives any number of heads, plus per-camera buttons
for small venues. Set an **access token** in the module once a PIN is set.

## How motion is kept safe

Every control in CamBridge sets a value and is done — except motion. "Pan left"
stays true on the camera until something says stop, so motion is handled
differently:

- **Deadman.** A move is held only while its source keeps refreshing it, about
  every 150 ms. The browser, the gamepad and Companion all do. If the refreshes
  stop — Wi-Fi drops, a tab is backgrounded — the head stops within half a
  second.
- **Latched sources.** A SKAARHOJ joystick held still, or a VISCA controller
  over TCP, does not refresh. Its moves are latched, and released the moment its
  connection closes — or, since a pulled cable closes nothing, when the
  SKAARHOJ heartbeat stops or a VISCA move goes 60 s without a repeat.
- **Stops never wait.** A stop does not wait behind a settings read.
- **Stops are confirmed.** A stop counts only when the camera has taken it.
  Until then the head is shown as moving and the stop keeps being sent.
- **Drops.** A camera that drops while moving, or with a stop unconfirmed, is
  sent a stop as soon as it reconnects. If nothing was moving, nothing is sent,
  so a move someone is making from Reactor at that moment is not cut across.
- **Shutdown and removal.** Shutting down, removing or re-addressing a camera
  refuses new moves and stops the head first.

## Camera notes — what to check on site

The drivers are written from each maker's protocol documents and tested against
simulators built from the same documents. That proves CamBridge matches our
reading of the spec — not that the camera does. Before relying on a camera:

```sh
./scripts/ptz-report.sh --out ptz.txt
```

It prints, for every PTZ camera: model, firmware, what it can do, every setting
with the value the camera gave, the settings it refused (hidden from the panel),
and the settings marked *verify*. Those came from an implementation or a sibling
model rather than the maker's document, and are the ones to try by hand.

### Sony BRC-AM7

- **VISCA is off until you switch it on.** Set rear **SETUP switch 4** to ON and
  power-cycle the camera; an **admin password** must also be set. Without VISCA,
  CamBridge still works over CGI — settings, presets, pan/tilt and zoom — but has
  no focus speed control, and Setup tells you what to switch on.
- PTZ Auto Framing: on/off, target, composition, framing preset and tracking
  range. Settings that appear only in Sony's 2026 Japanese CGI list are marked
  *verify*.
- Tally: CamBridge sends program and preview only if tally control on the camera
  is set to External.

### Panasonic AW-UE160

- **Auto Framing** needs Panasonic's Media Production Suite on a PC; the camera
  has no command for it. **Auto Tracking** (paid AW-SF100/200 key) can only be
  *read*, so CamBridge shows whether tracking is on but cannot switch it.
- Changes from elsewhere arrive immediately by push. The camera connects back to
  CamBridge on one port shared by all Panasonic heads. To allow it through a
  firewall on the CamBridge machine, set the same `options.notifyPort` on every
  Panasonic entry and open that port.
- Users, passwords, firmware update and factory reset have no documented
  command; use the camera's own page for those.

### Canon CR-N500

- **Auto tracking** appears only if Canon's licensed **RA-AT001** add-on answers
  on the camera.
- If Reactor or another controller holds the camera's control rights, CamBridge
  says so rather than silently doing nothing.
- Changes from elsewhere arrive by event stream; polling continues as a backstop.

### PTZOptics Move SE

- Uses raw VISCA on TCP 5678 for motion.
- **Presets 90–99, 150 and 151 are reserved** by PTZOptics — 150 and 151 switch
  auto tracking on and off — and CamBridge refuses them with the reason. The
  panel offers 0–89. 100–149 and 152–254 work from Companion, VISCA and the
  SKAARHOJ panel.
- Snapshots need firmware 9.1.66 / 9.1.44 / 9.1.46 or later, depending on lens
  variant; set `options.lens` (`12X`, `20X`, `30X`) if the camera does not report
  it.
- Many settings can only be *read back* on the Move 4K / Link 4K per the maker's
  document, so on the SE they are marked *verify*.

## Rehearsing without cameras

```sh
node scripts/ptz-rehearse.mjs --cameras 8
```

Starts simulators of all four makes — the same protocol simulators the tests
use — and runs CamBridge's real drivers against them. Every byte between
CamBridge and a "camera" is the real wire format as we read it.
`--cameras 48` rehearses a big venue.

For the panel alone, the simpler simulated heads need no protocol at all:

```sh
node cambridge/src/server.js --config config/ptz-sim.example.json
```

## Scale

Measured with 48 simulated heads running the real drivers, all in one process:

- **Each browser:** 1.7 KB/s while a head pans, against 213 KB/s for the old
  full-state stream. The first frame is about 97 KB gzipped.
- **The server:** about 30% of one core and 140 MB steady state.
- **The panel:** a position update for one head costs under 1 ms in the
  browser, whatever the camera count.

## Configuration

A PTZ camera's entry in `cambridge.json` — normally written by Setup:

```json
{
  "id": "stage-left",
  "kind": "ptz",
  "vendor": "panasonic",
  "label": "Stage left",
  "ip": "192.0.2.21",
  "group": "Stage",
  "auth": { "username": "…", "password": "…" },
  "options": {}
}
```

`vendor` is `panasonic`, `sony`, `canon` or `ptzoptics`. `port` overrides the
HTTP port (80). Useful `options`:

| Make | Option | Does |
|---|---|---|
| Panasonic | `notifyPort` | fixed port for change notifications (same on every Panasonic entry) |
| Panasonic | `push: false` | poll only |
| Panasonic | `snapshotResolution` | 320, 640 (default), 1280, 1920, 3840 |
| Sony | `viscaPort`, `viscaLocalPort` | VISCA port on the camera / the local port to send from |
| Canon | `panTiltSpeedMode` | `auto2` (default: slower at tele), `manual` (constant °/s), `camera` (leave as set) |
| Canon | `push: false`, `tracking: false` | poll only / do not look for RA-AT001 |
| PTZOptics | `viscaPort`, `model`, `lens` | VISCA TCP port (5678) / model and lens when the camera does not report them |

A top-level `ptz` block tunes the connection for every head (the defaults suit
most venues), and `"tallyFromAtem": true` lights the cameras' own tally lamps
from the switcher. Leave that off if Reactor already drives the lamps.
