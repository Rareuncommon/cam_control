# Network PTZ movement

CamBridge now drives network PTZ cameras independently of the Sony SDK daemon.
There are 49 named model profiles across six brands, plus four generic protocol
profiles. These are documented protocol targets, not hardware certifications.
All new PTZ profiles await physical-camera acceptance. The combined SDK/PTZ
portfolio contains 80 distinct model names; FR7 appears in both catalogs.

## Setup and controls

In **Setup → Network PTZ cameras**, select a model, enter its IPv4 address,
check the port, and add it. In Control, use **Check connection**, then hold a
pan/tilt or zoom button. Release it to request Stop. Diagonal movement, adjustable
speed, Home, native preset save/recall, and a dedicated Stop button are included.
Keyboard Space/Enter works while a movement button has focus. Moving focus,
switching tabs, hiding the page or releasing the pointer ends held movement.
Speed and preset selection survive incoming camera updates.

Enable the camera's network control protocol before adding it. Sony/Canon and
other VISCA models may require a firmware update, network-control menu setting
or hardware switch. Canon calls its VISCA interface Standard Communication (IP).
Choose Canon's **Source Port** response mode for the default reply port of zero.
If the camera sends replies to a fixed local port, enter that port explicitly.
AVer profiles default to a fixed local reply port of 52381. That port cannot also
host CamBridge's inbound VISCA bridge; configuration is rejected on a clash.

| Adapter | Default camera port | Local reply port | Notes |
| --- | --- | --- | --- |
| Sony-framed VISCA UDP | 52381 | Dynamic, or configured fixed | Sequence reset, reply sequence checking |
| Raw VISCA TCP | 5678 | TCP connection | PTZOptics Move 4K default |
| Raw VISCA UDP | 1259 | Dynamic | Select only for cameras configured for raw packets |
| Panasonic AW HTTP | 80 (HTTPS: set appropriate port) | HTTP connection | Basic/Digest authentication, command pacing |

Panasonic credentials are stored in the existing local configuration, which must
remain private; state/catalog responses never include passwords. HTTPS uses
normal certificate verification. Other VISCA adapters do not implement a
vendor-specific login. Use the protocol enabled by that camera's own setup.

Native preset slots are zero-based: VISCA profiles expose the conservative range
0–15; Panasonic exposes 0–99. The camera's remote may label them starting at 1.
These are camera positions, distinct from CamBridge's SDK exposure presets.
Preset contents and Home behavior depend on firmware. Lens zoom depends on the
installed lens; a protocol profile cannot make a manual lens motorized.

## Catalog and primary references

The source-linked machine-readable catalog is `cambridge/src/ptz/catalog.json`.
The generic profiles extend control to other cameras using the same exact wire
protocol; they do not imply ONVIF, serial, Pelco, UVC, NDI video, recording, media
transfer or image controls. PTZ-only cameras are excluded from recording totals
and SDK live-view requests.

| Brand | Named models | Manufacturer reference |
| --- | --- | --- |
| Sony | BRC-X400, BRC-X401, ILME-FR7, SRG-201M2, SRG-HD1M2, SRG-X120, SRG-X400, SRG-X402 | [Protocol / model documentation](https://pro.sony/support/res/manuals/E042/3230148ee903c204b912cca5c2c3f5aa/E0421001M.pdf) |
| Canon | CR-N100, CR-N300, CR-N350, CR-N400, CR-N500, CR-N700, CR-X300 | [Protocol / model documentation](https://gdlp01.c-wss.com/gds/7/0300047877/02/crn1sg-e.pdf) |
| BirdDog | O4, P240, X1, X1 30x, X1 Max, X1U, X4, X4E, X5, XL | [Protocol / model documentation](https://birddog.tv/o4-visca-over-ip-commands/) |
| PTZOptics | Move 4K | [Protocol / model documentation](https://downloads.ptzoptics.com/docs/move-4k) |
| Panasonic | AW-HE120, AW-HE130, AW-HE40, AW-HE50, AW-HE60, AW-HE65, AW-HE70, AW-UE30, AW-UE40, AW-UE50, AW-UE70, AW-UE80 | [Protocol / model documentation](https://eu.connect.panasonic.com/sites/default/files/media/document/2019-02/HDIntegratedCamera_InterfaceSpecifications-V1.07E.pdf) |
| AVer | PTZ310, PTZ310N, PTZ330, PTZ330N, TR311, TR311HN, TR313, TR320, TR331, TR333, TR530 | [Protocol / model documentation](https://www.averusa.com/pro-av/downloads/quick-start/AVer%20Pro-AV%20PTZ%20Visca%20over%20IP-UDP%20and%20RS-232%20Guide%20v3.pdf) |

Each profile retains its own source URL; a brand row above is a starting point.
Speed limits are conservative and model-specific. Hardware acceptance should
check both directions on each axis, zoom, release Stop, lease expiry, Home,
preset save/recall, standby, firmware settings and loss of connectivity.

## API and future Wordtandem integration

Use the existing authenticated local HTTP service. Admins add/remove connections
and save native presets; operators may move, Stop, probe, Home and recall.
`GET /api/ptz/catalog` lists profiles; `GET /api/ptz/cameras` and the combined
`GET /api/state`/SSE stream expose redacted state and capabilities.

Create a camera with `POST /api/ptz/cameras`:

```json
{"id":"ptz-canon","profile":"canon-cr-n300","host":"192.168.1.50"}
```

Send `POST /api/cameras/ptz-canon/actions/ptzMove`:

```json
{"controlId":"wordtandem-session-1","sequence":1,"leaseMs":700,"pan":0.25,"tilt":0,"zoom":0}
```

Axes range from -1 to 1; positive means right, up and telephoto. Renew with the
same controlId and an increasing sequence while movement is held. Leases must
be 150–1500 milliseconds. After Stop or expiry, use a new controlId. Another
controller cannot replace an active movement session, but any operator can Stop.

Send `ptzStop` with the same controlId and a higher sequence on release. An
unscoped `{}` Stop is also available. Other actions are `ptzProbe`, `ptzHome`,
`ptzPresetRecall` and `ptzPresetSave` (the last two accept `{"slot":0}`).
DELETE `/api/ptz/cameras/:id` attempts Stop and refuses removal without an
acknowledged Stop. Camera configuration persists across restart; movement never
automatically resumes.

A 202 response means **queued**, not moved. Read subsequent PTZ state for camera
acknowledgement and Stop status. VISCA movement accepts ACK; Stop requires
completion. Panasonic requires the expected response, not merely HTTP 200.
Camera acknowledgements cannot prove physical position or physical stopping.

A 50 ms watchdog requests pan/tilt and zoom Stop when a lease expires. Stale
commands are checked again at network dispatch. Failed commands are not blindly
replayed; Stop alone has bounded retries. Graceful shutdown attempts Stop.
A crashed process, broken network, or camera fault can prevent Stop from reaching
the mechanism; use the physical controller when stopping is unconfirmed.
Home/preset commands are one-shot camera operations, not leased velocity moves.

Wordtandem can reuse these endpoints and capability fields without embedding
vendor protocols into the prompter. This change does not modify Wordtandem or
provide cloud access to cameras. Companion now exposes bounded PTZ movement
pulses, Stop, Home/check and native presets.

## Verification

Run `npm --prefix cambridge test` and
`npm --prefix companion-module-cambridge test` from the repository root.
The tests use actual loopback TCP, UDP and HTTP simulators, including packet
framing, split TCP replies, wrong sequence rejection, camera refusals, authenticated
HTTP pacing, fixed reply ports, command races, expiry, stale-session rejection,
authorization, redaction, restart persistence and removal. No physical camera was
contacted during these checks.
