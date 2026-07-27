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

**Control** — per-camera iris, ISO, shutter, white balance, focus and record.
If iris or ISO is greyed out with "Iris is on Auto", that is the camera's
Flexible Exposure mode; the button next to it switches that parameter to Manual.

**Multiview** — live feeds from every connected camera. Click one to enlarge,
click again to go back. Live view has to be enabled on the body; a camera that
is not streaming shows a message rather than a black rectangle.

**Setup** — adoption, as above.

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
