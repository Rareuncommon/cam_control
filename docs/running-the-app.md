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

Each camera is a card. The controls you touch during a service are at the top,
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
    mid-service.
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
- Live view has to be enabled on the body; a camera that is not streaming shows
  a message rather than a black rectangle.

### Setup

Adoption, as above.

## Trying it without cameras

```sh
./scripts/start.sh --fake
```

Three simulated bodies, including a colour-bar feed in multiview and the same
Flexible Exposure gating a real FX30 has. Useful for showing someone the panel,
or for rehearsing a service without the rig.

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
