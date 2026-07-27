# Installing CamBridge on a fresh Mac

Cold start, in order, on a Mac that has nothing on it. Roughly 45 minutes, most
of which is downloads.

Works on a MacBook or a Mac Studio, Apple Silicon, macOS 12.1 or later.

---

## Before you start

Three things you need that this guide cannot get for you:

- **A Sony developer account**, for the Camera Remote SDK. Free, but it needs
  registration and a licence acceptance, so it has to be a human download.
- **Access to the `cam_control` repository** on GitHub.
- **The cameras' access-authentication details** — each body generates its own
  username and password, read off the camera itself in step 8.

---

## One rule that will save you an hour

**Every command below runs from the repo root**, which is
`~/cam_control` if you follow step 4.

This has caused real trouble twice. It is nasty because `git` keeps working from
the wrong directory, so a successful `git pull` tells you nothing — and `mkdir`
and `cp` will happily create a stray `~/vendor/CrSDK` where nothing will ever
find it, without printing an error. If a command fails in a way that makes no
sense, check `pwd` first.

`./scripts/preflight.sh` in step 6 treats being in the wrong directory as a hard
failure, and looks for that stray directory specifically.

**Also: paste one line at a time, or paste blocks exactly as written.** Do not
add your own `# comments` to a command line — macOS zsh does not enable
interactive comments, so it passes `#` to the program as an argument and you get
errors like `xcode-select: error: invalid argument '#'`.

---

## Step 1 — Xcode command line tools

```sh
xcode-select --install
```

A dialog appears; accept it and wait. If it says "already installed", good.

This gives you `clang`, `git` and `make`. You do **not** need full Xcode.

---

## Step 2 — CMake 3.24 or later

The only build tool needed beyond the Apple toolchain. Two ways; the first
avoids installing Homebrew at all.

**Option A — the official installer (no Homebrew)**

1. Download the macOS universal `.dmg` from <https://cmake.org/download/>
2. Drag **CMake.app** to `/Applications`
3. Put its `cmake` on your PATH:

```sh
echo 'export PATH="/Applications/CMake.app/Contents/bin:$PATH"' >> ~/.zprofile
```

Then **open a new terminal tab** so the change takes effect.

**Option B — Homebrew**

If you want Homebrew anyway, install it from <https://brew.sh>, then:

```sh
brew install cmake
```

Check it:

```sh
cmake --version
```

You need 3.24 or later.

> Sony's own README also lists `autoconf`, `automake` and `libtool`. Nothing in
> this build path uses them — they only matter if you build the bundled OSS
> dependencies from source, and Sony ships those prebuilt. Skip them.

---

## Step 3 — Node 22 or later

Needed by `cambridge`, the app server and web panel. `camd` builds and runs
without it, but you would have no UI.

**Option A — the official installer (no Homebrew)**

Download the macOS **Apple Silicon `.pkg`** from
<https://nodejs.org/en/download>, take the **LTS** build (22 or later), run it.

**Option B — Homebrew**

```sh
brew install node
```

Check it:

```sh
node --version
```

Must be `v22` or higher. CamBridge uses Node's built-in WebSocket client and
test runner, which is how it manages to have **zero npm dependencies**.

---

## Step 4 — Get the code

```sh
cd ~
git clone https://github.com/Rareuncommon/cam_control.git
cd ~/cam_control
```

GitHub will ask you to authenticate in a browser the first time.

The default branch is the one with all the work on it, so a plain clone gets you
the right code.

---

## Step 5 — The Sony Camera Remote SDK

**Download it yourself** from Sony's pro support site. It requires registration
and licence acceptance, and it must never be committed to this repo.

Get **Camera Remote SDK 2.02.00 for macOS**. The download splits into several
archives — you only need **`RemoteCli.zip`**. The `libssh2`, `libusb` and
`openssl` zips are OSS source published for licence compliance; the prebuilt
libraries already ship inside `RemoteCli.zip`.

Unzip it, then from the **repo root**:

```sh
cd ~/cam_control
UNPACKED=~/Downloads/RemoteCli
mkdir -p vendor/CrSDK/include vendor/CrSDK/lib
cp -R "$UNPACKED/app/CRSDK" vendor/CrSDK/include/
cp -R "$UNPACKED/external/crsdk/." vendor/CrSDK/lib/
xattr -dr com.apple.quarantine vendor/CrSDK
```

Set `UNPACKED` to wherever you actually unzipped it.

Three things worth knowing about those commands:

- Copy the **whole** contents of `external/crsdk/`, not just `libCr_Core.dylib`.
  The core library references `libmonitor_protocol.dylib` by name, and loads its
  transport adapters out of `CrAdapter/`.
- The `xattr` line is not optional. Without it macOS refuses to load the dylibs
  and you get a confusing failure at runtime rather than at install time.
- Keep the unpacked `RemoteCli` folder. The Phase 0 acceptance test builds Sony's
  own sample from it, which is the fastest way to prove a camera is reachable
  without involving any of this code.

More detail, including the exact resulting layout:
[`docs/sdk-install.md`](sdk-install.md).

---

## Step 6 — Preflight

```sh
cd ~/cam_control
./scripts/preflight.sh
./scripts/check-sdk.sh
```

The first checks the machine, the second checks the SDK landed correctly. Both
install nothing — they report, and print the exact command to fix each gap.

Do not continue until both are clean.

---

## Step 7 — Build

```sh
cd ~/cam_control
cmake -S camd -B camd/build -DCMAKE_BUILD_TYPE=Release
cmake --build camd/build -j8
```

Then prove it works, with no cameras and no hardware involved:

```sh
./camd/build/camd_tests
```

You want `55 passed, 0 failed`.

And the Node side:

```sh
cd ~/cam_control/cambridge
node --test test/*.test.js
cd ~/cam_control
```

You want `# fail 0`.

---

## Step 8 — Cameras on the network

Physical setup: each body on wired Ethernet via a USB-C→LAN adapter, all on the
same production VLAN as the Mac, with static IPs.

On **each** camera:

| Setting | Where |
|---|---|
| Static IP | `MENU → (Network) → [Wired LAN] → [IP Address Setting] → [Manual]` |
| USB-LAN on | `MENU → (Network) → [USB-LAN/Tethering] → [USB-LAN Connection]` |
| Reconnect after power cycle | `MENU → (Network) → [USB-LAN/Tethering] → [USB-LAN Cnct. Launch] → [On]` |
| Remote shooting on | `MENU → (Network) → [Cnct./Remote Sht.] → [Remote Shoot Function] → [Remote Shooting] → [On]` |
| Read the credentials | `MENU → (Network) → [Network Option] → [Access Authen. Info]` |

**Write down the username and password from that last screen for each body.**
Every camera generates its own — they are not shared, and they are not anything
you choose. You will type them in during step 9.

> **Or skip passwords entirely.** Turning
> `[Access Authen. Settings]` **off** on each body removes them. CamBridge asks
> each camera whether it wants credentials and connects with none when it does
> not, so there is nothing to configure and the Setup tab stops asking.
>
> The trade-off: anything that can reach the camera on the network can then
> control it. That is fine on a dedicated production VLAN with no internet route
> — and is how the rest of a broadcast rack already works, since VISCA, NDI and
> ATEM control have no authentication at all. It is not fine on a shared office
> or company-wide network. If you are unsure the VLAN is genuinely isolated, leave
> it on: it is a one-time cost per body.
>
> Either way the password cannot be discovered over the network — it is shown on
> the camera's screen and nowhere else, by design.

Full detail, including the IP plan and the power-saving settings that will
otherwise drop a camera mid-take:
[`docs/camera-setup.md`](camera-setup.md).

---

## Step 9 — First run, and adding the cameras

Start with the config template:

```sh
cd ~/cam_control
cp config/cambridge.example.json config/cambridge.json
```

Open `config/cambridge.json` and **delete the three example entries in the
`cameras` array**, leaving `"cameras": []`. You will add the real ones from the
browser, which is easier and less error-prone than editing JSON.

Start it:

```sh
./scripts/start.sh
```

Open the URL it prints, go to the **Setup** tab, and every camera on the network
appears. Press **Add** on each one and give it a name and the username and
password you wrote down in step 8.

Cameras connect immediately — no restart — and are saved to
`config/cambridge.json` so they come back on their own.

`Ctrl-C` in the terminal stops everything.

> **Want to see the panel before the cameras are ready?**
> `./scripts/start.sh --fake` gives you three simulated bodies, including
> colour-bar feeds in Multiview and the same Auto-exposure gating a real FX30
> has. Useful for a rehearsal, or for showing someone the panel.

---

## Step 10 — Make it a double-clickable app

Once step 9 works, you never need the terminal again:

```sh
cd ~/cam_control
./scripts/make-app.sh /Applications
```

That builds **CamBridge.app**. Double-click it and it starts the daemon and the
server, waits until they are actually answering, and opens the panel in your
browser. Quitting it stops both. Drag it to the Dock.

The app is a thin wrapper — all the real code stays in `~/cam_control` and the
app runs whatever is checked out there, so it never goes stale. Re-run
`make-app.sh` only if you move the repo.

**Do not delete or move `~/cam_control` after this.** The app points at it.

---

## Optional — start automatically at login

There is a launchd plist in `launchd/`. Use this only if you want the cameras
connected before anyone opens anything; for most booths the app icon is enough.

---

## Optional — Stream Deck, tally, joystick, gamepad

Everything in [`docs/integrations.md`](integrations.md) is off until you switch
it on, and none of it is needed to run a shoot:

- **Bitfocus Companion** — a Stream Deck module. Needs one `npm install` inside
  `companion-module-cambridge/`; it is the only part of this project with an npm
  dependency.
- **ATEM tally** — marks the live camera ON AIR in the panel. Edit `config/cambridge.json`.
- **VISCA** — lets a hardware joystick drive the cameras. Edit `config/cambridge.json`.
- **Gamepad** — plug in any controller the browser recognises; nothing to install.

---

## Updating later

```sh
cd ~/cam_control
git pull
cmake --build camd/build -j8
```

The SDK in `vendor/CrSDK/` and your `config/cambridge.json` are both git-ignored,
so neither is touched by a pull. You do not need to redo steps 5 or 9.

---

## Setting up a second Mac

Repeat every step. `vendor/CrSDK/` is deliberately **not** in version control —
the SDK is licensed per developer, so each machine downloads it from Sony
directly.

Your camera credentials live only in `config/cambridge.json`, which is also
git-ignored, so they do not travel with the repo. Either re-add the cameras from
the Setup tab on the new machine, or copy that one file across by hand.

---

## When something goes wrong

Logs are in `logs/`:

| File | What it holds |
|---|---|
| `launch.log` | app startup, and why it stopped if it did |
| `camd.log` | every camera connection, disconnection and record command |
| `cambridge.log` | operator actions — what was pressed, and when |

Read `camd.log` and `cambridge.log` together: one is what the cameras did, the
other is what was asked of them.

**Common ones:**

| Symptom | Cause |
|---|---|
| `command not found: cmake` / `node` | Step 2 or 3 not done, or you did not open a new terminal tab after editing `~/.zprofile` |
| `invalid argument '#'` | You pasted a command with a `#` comment on the end of the line |
| `CMake Error: source directory does not exist` | You are not in `~/cam_control`. Run `pwd` |
| No cameras in the Setup tab | Camera not reachable. Re-check the USB-LAN and Remote Shooting settings in step 8 |
| `wrong password` on a camera | Credentials are per-body. Re-read that camera's own `Access Authen. Info` screen and use **Edit** in the Setup tab |
| `Permission denied` running a script | `chmod +x scripts/*.sh` |
| Port already in use | Something is already running — see below |

To clear a stuck port:

```sh
lsof -ti:8088 | xargs kill
lsof -ti:8787 | xargs kill
```
