# Running CamBridge as an app

Normal operation needs no terminal at all.

## One-time setup

Build the daemon and make the app:

```sh
cd ~/cam_control
cmake -S camd -B camd/build && cmake --build camd/build
./scripts/make-app.sh /Applications
```

That produces **CamBridge.app**. Drag it to the Dock if you want it there.

The app is a thin wrapper — all the real code stays in this repo and the app
runs whatever is checked out, so it never goes stale. Re-run `make-app.sh` only
if you move the repo.

## Day to day

Double-click **CamBridge**. It will:

1. start the camera daemon and the web server
2. wait until the daemon is actually answering
3. open the control panel in your browser

Quitting the app (Cmd-Q, or right-click the Dock icon → Quit) stops both.

If something goes wrong before the browser opens, you get a dialog rather than a
silent failure, with a button to open `logs/launch.log`.

### On the iPad

The panel is served to the whole network. The URLs are printed at startup and
also in `logs/cambridge.stdout.log`; use the one on the same subnet as the iPad.
For this studio that is the `172.16.16.x` address, the production VLAN.

## Adding cameras — the Setup tab

No config editing. Open **Setup** and you get every camera CamBridge can see on
the network, whether or not it is adopted.

For each one you want to control, press **Adopt** and give it:

- **Name** — what you call it in the booth: Wide, Centre, Tight
- **Username** and **Password** — from the camera itself:
  `MENU → Network → Network Option → [Access Authen. Info]`

> Every camera generates **its own** username and password. They are not shared
> between bodies, and they are not the same as anything you type on the Mac.

The camera connects immediately — no restart, and the other cameras keep
running throughout. It is saved to `config/cambridge.json` so it comes back on
its own next time.

**Edit** renames a camera or replaces its credentials, which is what you need if
a body is reinitialised and generates new ones. **Remove** forgets it here; the
camera itself is untouched.

If a camera does not appear in the list, it is not reachable. Check on the body:

- `MENU → Network → USB-LAN/Tethering → USB-LAN Connection`
- `MENU → Network → Cnct./Remote Sht. → Remote Shoot Function → Remote Shooting → On`
- `MENU → Network → USB-LAN/Tethering → USB-LAN Cnct. Launch → On` — so it comes
  back by itself after a power cycle

## The three tabs

### Control

Each camera is a card. The controls you touch during a shoot are at the top,
always visible, in the order you actually reach for them: **iris, ISO, shutter,
ND** (on the FX30s) and **Kelvin**, then the record button.

Every one of those is a **stepper** — a big minus, the current value, a big
plus:

```
IRIS   [ − ]  [  f/4.0  ]  [ + ]
```

- **−** and **+** move one stop at a time. On iris, **+** means *more light*,
  which is the direction your hand expects, not a rising f-number.
- **Tap the value in the middle** to open the full list and jump straight to
  something far away.
- A greyed-out stepper is not broken. If iris, ISO or shutter is locked you will
  see "Iris is on Auto" underneath with a **Set Manual** button — that is the
  camera's Flexible Exposure mode, and the button unlocks it.

Everything else is behind **More controls** on each card: white balance mode and
tint, focus (slider, nudge, AF), AF mode, ND mode, contrast, saturation,
sharpness, zebra, peaking, subject tracking, SteadyShot, per-camera presets, and
a **menu pad** that drives the camera's own on-screen menu with the Multiview
feed as your monitor.

**More controls** in the top bar opens that section on *every* card at once and
remembers the choice, so a booth iPad comes back the way you left it.

Below the cards, **Scenes, match & linked cameras**:

- **Scenes** capture every camera at once and recall them together.
  - **Recall only** — leave all three chips off to recall the whole scene, or
    turn on *Exposure*, *White balance* or *Look* to restore just that part.
    Recalling white balance without disturbing exposure is the common one
    mid-take.
  - **Ramp over** — recall instantly, or glide over 1–8 seconds. An instant iris
    change is visible on air; a two-second ramp is not. The ramp is computed
    here and sent as ordinary property writes, so the daemon stays dumb.
- **Match** copies exposure and colour from one camera to the others. Values
  that cannot cross sensor sizes exactly are approximated, and you are told how
  many.
- **Link** gangs cameras so one change drives all of them.

### Multiview

Live feeds from every connected camera.

- **Tap anywhere on a picture to focus there.** The tap is sent as a normalised
  position, so the browser never needs to know the camera's AF grid.
- Each feed has **AF**, a **record** button and **Enlarge**.
- A camera that is not streaming shows the reason rather than a black rectangle.

The tap is measured against the **picture**, not the tile. A live view that is
not 16:9 sits letterboxed inside the tile with black bars, and tapping a bar
does nothing at all — it is not a request to focus at the extreme edge of frame,
and treating it as one would put focus somewhere nobody pointed.

#### If tapping does not focus

Not every body accepts a focus point over the SDK. Where it does not, the panel
says so once and offers **Focus with AF** instead of repeating a daemon error on
every tap — plain autofocus works on those cameras, it just uses the camera's
own AF area rather than the spot you touched.

To find out what a particular body does and does not offer:

```sh
./scripts/focus-report.sh
```

No arguments — it finds the port and the camera ids itself. Add `--full` for
every property as JSON, or `--out report.txt` to write it to a file.

It lists **every** property each camera announces, including the ones CamBridge
has no name for. That matters because the ordinary property list is filtered
down to what CamBridge models, so a property the body genuinely lacks and one
CamBridge simply never asks about look identical — and only the unfiltered list
tells them apart.

Run it once with Focus Area set to **Wide** on the camera and again with it on
**Flexible Spot**. If an AF area property appears only in the second, tapping
can be made to work by switching Focus Area automatically.

Feeds are polled a frame at a time rather than streamed as MJPEG. MJPEG in an
`<img>` is rendered by Chrome and Firefox and **not by Safari**, which simply
fires an error — so on a Mac, where the panel opens in whatever the default
browser is, the feeds were black while single frames worked perfectly. Polling
costs a little more and works everywhere.

#### Monitoring assists

Frames are decoded into a canvas, so the panel can read the pixels. Everything
below is computed in the browser from frames it already has — the cameras are
not asked for anything extra, and none of it touches the daemon.

**Exposure** replaces or marks the picture, one mode at a time:

| Mode | What it does |
|---|---|
| Normal picture | the feed as the camera sends it |
| False colour | every pixel replaced by the band its brightness falls in |
| Mark clipping | blown highlights go red, crushed blacks go blue, the rest is left alone |

*Mark clipping* is the one you can leave on during a take, because the picture
stays recognisable. *False colour* is for setting up.

Press **Key** for what the false-colour bands mean. The one worth memorising is
the wide pink band: that is where a correctly exposed face sits on these bodies,
so **"make the face pink"** is the usable version of this on set.

The chips can all be on at once, because they draw over the picture rather than
replacing it:

- **Histogram** — brightness distribution, top right of each feed. The red edge
  is clipping, the blue edge is crush.
- **Clip %** — how much of the frame is blown or crushed. It appears only when
  there is something to report; a permanent "0.0%" is a thing people stop
  reading.
- **Thirds**, **Centre**, **Safe area** — framing guides. Safe area is the 90%
  action-safe box.

**Matte** shows the frame as it will be delivered — 16:9 or 2.39:1 — with the
part you are going to lose dimmed rather than outlined, because a thin line does
not tell you what is being cropped.

All of it is remembered per browser, so a booth iPad comes back the way it was
left.

### Setup

Adoption, as above — plus who is allowed to do it.

#### Who can control the cameras

Out of the box there is **no PIN**, and the panel says so on every screen:
anyone who can reach the address has full control and can read the cameras'
stored passwords. That is the default because locking the panel as a side
effect of an upgrade — on a shoot day, with nobody knowing the PIN — would be
worse than the exposure. It is not a good permanent state.

Set a PIN in **Setup → Who can control the cameras**. There are two levels:

| | Can do |
|---|---|
| **Operator** | everything that affects the shoot in progress: exposure, record, focus, presets, scenes, match, undo |
| **Admin** | all of that, plus what outlasts the shoot: adding and forgetting cameras, changing a stored password, quitting CamBridge |

Set the operator PIN first if you only want one level — with no admin PIN
configured, one PIN means one level of access, and the split starts the moment
you add an admin PIN.

Sessions last sixteen hours, so nobody signs in twice in a day.

#### Companion, scripts and anything that is not a person

Machine clients cannot answer a PIN prompt, so they use a token instead. Add one
to the config:

```json
"auth": {
  "tokens": { "a-long-random-string": "operator" }
}
```

and have the client send it as `Authorization: Bearer a-long-random-string`.
Give it `operator` unless it genuinely needs to adopt cameras. Tokens are as
sensitive as the PIN — anyone holding one can drive the cameras.

Every action is logged with who took it: a PIN session as `operator` or
`admin`, a token by a short fingerprint that identifies it without disclosing
it. Read `cambridge.log` to see who changed what.

## Trying it without cameras

```sh
./scripts/start.sh --fake
```

Three simulated bodies, including a colour-bar feed in multiview and the same
Flexible Exposure gating a real FX30 has. Useful for showing someone the panel,
or for rehearsing a shoot without the rig.

You can also rehearse a camera dropping out:

```sh
curl -X POST localhost:8787/debug/link/AA:BB:CC:00:00:02 -d '{"down":true}'
```

## When something is wrong

Logs live in `logs/`:

| File | What it holds |
|---|---|
| `launch.log` | app startup, and why it stopped if it did |
| `camd.log` | every camera connection, disconnection and record command |
| `cambridge.log` | operator actions — what was pressed, and when |

`camd.log` and `cambridge.log` are the pair to read together on a Monday
morning: one is what the cameras did, the other is what was asked of them.
