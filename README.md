# CamBridge

Multi-camera control through Sony Camera Remote SDK, with network and USB
connection identities. The camera catalog covers all 32 models listed for SDK
2.02, including Alpha, Cinema Line, professional camcorders, PTZ, ZV and RX.
Controls are discovered from each connected body, lens and camera mode.

**Hardware baseline:** 1× ILME-FX3 and 2× ILME-FX30, wired Ethernet, Apple Silicon
Mac. The 30 additional model profiles await real-camera acceptance; adding a
profile is not a claim that every feature works on that model.

**Compatibility and future Wordtandem integration:**
[`docs/camera-support.md`](docs/camera-support.md).
Internal studio use; Sony SDK redistribution terms still apply.

---

## Current status

**Phases 1–5 are built. Phases 2, 4 and 5 await their hardware acceptance runs.**

Phase 0 passed on hardware. Phases 1–5 are implemented and verified as far as is
possible without the studio rig. Automated tests cover the daemon, application
server and Companion module; the broader USB/network portfolio has its own
simulated acceptance checks. See the compatibility document for current limits.
What only real cameras can settle is listed in
[`docs/phases-1-5.md`](docs/phases-1-5.md).

**Setting up a Mac?** Start at [`docs/setup.md`](docs/setup.md) — it points you
at the DMG (five minutes, nothing to install) or the full source build
([`docs/install.md`](docs/install.md)), and covers camera setup. Use access credentials when the camera requires them;
keep Access Authentication enabled for the existing FX3/FX30 network rig.

```sh
./scripts/make-dmg.sh
```

builds a self-contained `dist/CamBridge-<version>.dmg` carrying the daemon, the
Sony SDK, the panel and Node. Drag onto Applications on any Mac in the company.

It runs as a **double-clickable macOS app** with no terminal use:
[`docs/running-the-app.md`](docs/running-the-app.md).

```sh
cmake -S camd -B camd/build && cmake --build camd/build
./scripts/make-app.sh /Applications
```

Then double-click **CamBridge**. Cameras are added from the **Setup** tab — no
config editing — and the app has three tabs: Control, Multiview, Setup.

To try it without hardware, or to run it from a terminal:

```sh
./scripts/start.sh --fake
# Six mixed USB/network bodies, including two identical USB Alpha cameras:
./scripts/start.sh --fake-portfolio
```

### What the panel does

The controls a shoot actually needs are on the face of each camera card —
**iris, ISO, shutter, ND, Kelvin** — each as a big `−  value  +` stepper rather
than a dropdown, so the current value is readable without opening anything and
the targets suit a finger on an iPad. Tapping the value opens the full list for
a big jump. On iris, **+** means more light.

Behind **More controls**, per camera: white balance and tint, focus (absolute,
relative nudge, AF), AF mode, ND mode, contrast, saturation, sharpness, zebra,
peaking, subject tracking, SteadyShot, presets, and a **menu pad** that drives
the camera's own on-screen menu using the Multiview feed as the monitor.

Across all cameras: **scenes** with selectable recall (restore just white
balance and leave exposure alone) and an optional **1–8 second ramp** so a
change is not visible on air, **match** to copy a look from one body to the
others, **link** to gang cameras, and record-all / stop-all.

**Multiview** streams every camera, with **tap-to-focus** — touch the picture
where you want focus and the normalised position goes to the camera.

Full walkthrough: [`docs/running-the-app.md`](docs/running-the-app.md).

### Driving it from something other than the browser

A **Bitfocus Companion** module (`companion-module-cambridge/`) puts record,
exposure, scenes and tally on a Stream Deck, with feedbacks so a record button
goes red by itself. **ATEM tally** marks the live camera ON AIR in the panel and
on Companion. A **VISCA** server lets a hardware joystick drive the cameras. And
any **gamepad** the browser sees can ride the iris through a song.

All four are off until switched on. Setup, and what each still needs real
hardware to confirm: [`docs/integrations.md`](docs/integrations.md).

| Phase | Scope | Status |
|---|---|---|
| 0 | Toolchain + SDK + one camera over Ethernet via Sony's own sample | ✅ **passed** |
| 1 | `camd` core — single camera, property get/set, record, over REST | ✅ built, `curl` acceptance passes |
| 2 | Multi-camera + connection lifecycle; kill tests 5/5 | built; **hardware kill tests outstanding** |
| 3 | WebSocket events + Node bridge with mirrored state | ✅ built and verified end to end |
| 4 | Web control panel, laptop + iPad landscape | built; **your mock-service run outstanding** |
| 5 | Presets, scenes, gang control, match mode | built; **you define the acceptance tests** |
| 6 | Live multiview | ✅ built |
| — | Camera adoption from the UI, macOS app | ✅ built (beyond the original brief) |
| — | Expanded control set + touch-first UI rework | built; **two items need a real body, below** |
| 6+ | Bitfocus Companion module | ✅ built and verified end to end |
| 6+ | ATEM tally, VISCA server, gamepad | built; **tally and VISCA need your hardware to confirm** |
| 6+ | Q-SYS | backlog, not built |

Phases 1–5 were built in one pass at your request, rather than gated one at a
time. The hardware acceptance tests still gate calling them *done* — see
[`docs/phases-1-5.md`](docs/phases-1-5.md) for exactly what is proven and what
is not.

---

## Architecture

Two processes, split so that protocol handling and business logic never
contaminate each other.

```
  Browser (laptop / iPad)
        │  HTTP + WS
        ▼
  cambridge  ── Node.js ──  all business logic:
        │                    state model, presets, gang, match, logging
        │  WS (loopback)
        ▼
  camd       ── C++ ──      protocol translation only:
        │                    connections, property get/set, events
        │  Sony Camera Remote SDK
        ▼
  FX3 + FX30 + FX30 over Ethernet
```

**`camd`** is deliberately thin and dumb. It holds persistent SDK connections,
translates REST/WS calls into SDK calls, and pushes events back. It reports raw
SDK values with no interpretation. See [`camd/README.md`](camd/README.md).

**`cambridge`** owns everything that requires a decision: normalising FX3
(full-frame) against FX30 (Super 35) value ranges, presets, ganging, matching,
and the operator-facing log. See [`cambridge/README.md`](cambridge/README.md).

### Why the split

The daemon is the part that must never die during a shoot. Keeping it free of
features means the code that has to survive a camera vanishing mid-song is
small enough to reason about completely. Everything that changes often lives in
the layer written in the language this repo's author actually enjoys debugging
at the start of a shoot day.

---

## Setup, from cold

0. **Clone the repo and check prerequisites.** Every command in these docs uses
   paths relative to the repo root, so `cd` into the checkout first — running
   them from `~` silently creates stray directories in your home folder.
   ```sh
   git clone https://github.com/Rareuncommon/cam_control.git ~/cam_control
   cd ~/cam_control
   ./scripts/preflight.sh
   ```
   `preflight.sh` installs nothing — it checks you are in the right directory and
   that the toolchain is present, printing the exact fix command for any gap.

   Prerequisites, and nothing else:

   | Need | For | Without Homebrew |
   |---|---|---|
   | Xcode command line tools | compiling `camd` | `xcode-select --install` |
   | CMake 3.24+ | building `camd` | universal `.dmg` from <https://cmake.org/download/> |
   | Node 22+ | `cambridge` and the web UI | Apple Silicon `.pkg` from <https://nodejs.org/en/download> |

   Homebrew is optional throughout. Sony's README also lists autoconf, automake
   and libtool, but nothing in the build path uses them — the bundled OSS
   dependencies ship prebuilt. `camd` alone needs no Node at all.
1. **Cameras** — configure each body per [`docs/camera-setup.md`](docs/camera-setup.md).
   Read the access-authentication credentials off each one while you are there.
2. **SDK** — download and place the Sony Camera Remote SDK per
   [`docs/sdk-install.md`](docs/sdk-install.md). It is licensed per-developer
   and is never committed to this repo.
3. **Config** — `cp config/cambridge.example.json config/cambridge.json` and
   fill in IPs, credentials, and ports. The real file is git-ignored because it
   holds camera passwords.
4. **Verify** — `./scripts/check-sdk.sh`, then build and run `camd-linkcheck`.
5. **Phase 0 test** — [`docs/phase-0-acceptance.md`](docs/phase-0-acceptance.md),
   driving Sony's sample per
   [`docs/remotecli-walkthrough.md`](docs/remotecli-walkthrough.md). Already
   passed once; repeat it on a new machine or after an SDK upgrade.

---

## Repo layout

```
camd/            C++ control daemon: config, HTTP/WS, per-camera workers, Sony backend
cambridge/       Node.js app server + single-file web UI; zero npm dependencies
CamBridge.app/   generated by scripts/make-app.sh; git-ignored
config/          single editable config file; real one is git-ignored
docs/            SDK install, camera setup, per-phase acceptance tests
launchd/         macOS service definition for camd
scripts/         SDK verification and Sony sample-app build helpers
vendor/CrSDK/    where the Sony SDK goes; git-ignored except the placement guide
```

---

## Operating principles

Carried from the project brief. These override convenience.

- **Reliability over features.** This runs live productions.
- **Fail loud in the UI, fail soft in the daemon.** A camera dropping is a
  banner in the browser, never a crashed process.
- **One dead camera affects nothing else.** Non-negotiable, and the thing
  Phase 2's kill tests exist to prove.
- **Everything logged, timestamped, rotating.** Postmortems happen after wrap.
- **No cloud.** Everything runs on the studio LAN.
- **Config in one file.** IPs, credentials, ports.

## Decisions on record

- **Focus is exposed both as absolute position and relative nudge.** Lens
  support for absolute positioning varies; `cambridge` chooses per lens.
  Consequence: presets can only store focus on lenses that report absolute
  position, and the UI must say so rather than silently recalling nothing.
- **`camd` binds loopback only.** Nothing off-machine talks to the daemon
  directly. `cambridge` binds all interfaces so the iPad can reach the UI.
- **`camd` never normalises across bodies.** Raw SDK values only. The FX3/FX30
  sensor-size difference is a display and business-logic concern.

## Licence

Internal studio use. The Sony Camera Remote SDK is separately licensed by Sony
and is not distributed with this repo.
