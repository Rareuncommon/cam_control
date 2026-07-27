# Setting up CamBridge

Two ways in. Pick one.

| | Use when | Takes |
|---|---|---|
| **[The DMG](#a--the-dmg)** | Putting CamBridge on a machine that just needs to run it | ~5 minutes |
| **[From source](install.md)** | Building the DMG, or developing | ~45 minutes, once |

Someone has to do the source install once, on one Mac, to produce the DMG. After
that every other machine gets the DMG.

---

## First: leave access authentication ON

**Confirmed on the FX3 and both FX30 bodies:** with
`[Access Authen. Settings]` turned **Off**, the cameras are discovered on the
network but refuse remote control — they connect and drop in a loop, forever.
Turning it back On fixes it immediately. Tested by turning it off on all three,
watching all three fail identically, and turning it back on.

So on **each** camera, confirm:

```
MENU → (Network) → [Network Option] → [Access Authen. Settings] → On
```

and read its credentials from:

```
MENU → (Network) → [Network Option] → [Access Authen. Info]
```

Write down the **username and password** for each body. They are randomly
generated per camera, they are not shared, and they are not something you
choose. You enter each one **once** — CamBridge stores it against that camera's
MAC address and reconnects on its own from then on, including across IP changes
and reboots.

> **Why there is no passwordless option.** It is not a limitation of this app.
> CamBridge already asks each camera whether it wants credentials and connects
> with none when it says no — and Sony's SDK has a single `Connect` whose
> credential arguments default to null, so the no-authentication call is exactly
> what we make. The bodies themselves decline to be controlled over LAN without
> it. Nothing in this codebase can change that.
>
> The password also cannot be discovered over the network. It is shown on the
> camera's own screen and nowhere else, which is the point of it.
>
> If a future firmware does allow control with authentication off, CamBridge
> will handle it without changes: the Setup tab already adapts to what each
> camera reports.

While you are in the camera menus, the rest of the network setup:

| Setting | Where |
|---|---|
| Static IP | `MENU → (Network) → [Wired LAN] → [IP Address Setting] → [Manual]` |
| USB-LAN on | `MENU → (Network) → [USB-LAN/Tethering] → [USB-LAN Connection]` |
| Reconnect after a power cycle | `MENU → (Network) → [USB-LAN/Tethering] → [USB-LAN Cnct. Launch] → [On]` |
| Remote shooting on | `MENU → (Network) → [Cnct./Remote Sht.] → [Remote Shoot Function] → [Remote Shooting] → [On]` |

Full detail, including the power-saving settings that will otherwise drop a
camera mid-take: [`camera-setup.md`](camera-setup.md).

---

## A — The DMG

### Building it

On the Mac that has the repo and the Sony SDK:

```sh
cd ~/cam_control
./scripts/make-dmg.sh
```

Out comes `dist/CamBridge-<version>.dmg`, around 130 MB. It contains everything:
the daemon, the Sony SDK libraries, the web panel, and a copy of Node. The target
Mac needs nothing installed.

Options:

```sh
./scripts/make-dmg.sh --no-node        smaller, but the target Mac needs Node
./scripts/make-dmg.sh --out ~/Desktop  write it somewhere else
```

The script refuses to bundle a Node that links to Homebrew libraries, because
that produces an app which runs on the machine that built it and dies on every
other one. If it warns about this, install Node from nodejs.org and rebuild.

> **Keep the DMG inside the company.** It embeds Sony's Camera Remote SDK, which
> is licensed per developer and must not be redistributed.

### Installing it

1. Open the DMG, drag **CamBridge** onto **Applications**.

2. **First launch only:** right-click CamBridge in Applications and choose
   **Open**, then confirm.

   macOS blocks it the normal way because the app is not signed with a paid
   Apple Developer certificate. This is expected. If it instead says the app is
   *damaged*, that is the quarantine flag — clear it once:

   ```sh
   xattr -dr com.apple.quarantine /Applications/CamBridge.app
   ```

3. Open CamBridge. It starts the daemon and the panel and opens your browser.
   Quitting it stops everything.

4. **Setup** tab → **Add** each camera. With authentication off, that is a name
   and nothing else.

Where things live after install:

| | |
|---|---|
| Cameras and settings | `~/Library/Application Support/CamBridge/cambridge.json` |
| Logs | `~/Library/Logs/CamBridge/` |

Both are outside the app bundle, so replacing CamBridge with a newer build keeps
your camera list.

### Updating

Build a new DMG, drag the new app over the old one. Nothing else to do.

---

## B — From source

[`install.md`](install.md) — Xcode command line tools, CMake, Node, the repo, the
Sony SDK, build, and run. That is also what you need to build the DMG in the
first place.

---

## After either route

**Using it day to day:** [`running-the-app.md`](running-the-app.md) — the
steppers, scenes with ramping, match, multiview and tap-to-focus.

**Stream Deck, tally, joystick, gamepad:** [`integrations.md`](integrations.md).
All optional, all off until switched on.

---

## If something is wrong

Logs first. From the DMG install they are in `~/Library/Logs/CamBridge/`; from
source they are in `logs/` inside the repo.

| File | What it holds |
|---|---|
| `launch.log` | app startup, and why it stopped if it did |
| `camd.log` | every camera connection, disconnection and record command |
| `cambridge.log` | operator actions — what was pressed, and when |

Read `camd.log` and `cambridge.log` together: one is what the cameras did, the
other is what was asked of them.

| Symptom | Cause |
|---|---|
| "CamBridge is damaged and can't be opened" | Quarantine flag. Run the `xattr` command above |
| "unidentified developer" | Expected on first launch. Right-click → Open |
| App opens, then quits | Check `launch.log`. Usually Node missing on a `--no-node` build |
| No cameras in Setup | Camera not reachable. Re-check USB-LAN and Remote Shooting |
| "wrong password" on a camera | Credentials are per-body. Re-read that camera's own `[Access Authen. Info]` and use **Edit** — or turn authentication off on it |
| Panel opens but says the daemon is unreachable | `camd` did not start. `camd.stdout.log` has the reason |
