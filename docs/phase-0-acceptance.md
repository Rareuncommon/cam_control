# Phase 0 — acceptance

**Goal:** prove the toolchain, the SDK, the network, and the camera menu
configuration all work *before* we write a line of our own camera code.

**Acceptance test:** Sony's own `RemoteCli` sample app starts and stops
recording on one FX30 over wired Ethernet.

Nothing in Phase 1 starts until that passes. If it fails, the fault is in the
environment, and the whole point of this phase is to find that out while it is
still cheap.

---

## Checklist

### A. Camera (one FX30 only for now)

Work through [`docs/camera-setup.md`](camera-setup.md) on a single body:

- [ ] Firmware version recorded (needs Ver. 3.00+ for USB-LAN at minimum)
- [ ] USB-C → gigabit Ethernet adapter connected; nothing on the Multi/Micro USB terminal
- [ ] `Wired LAN → IP Address Setting → Manual`, static IP set
- [ ] `USB-LAN/Tethering → USB-LAN Connection` selected
- [ ] `USB-LAN/Tethering → USB-LAN Cnct. Launch → On`
- [ ] `Cnct./Remote Sht. → Remote Shoot Function → Remote Shooting → On`
- [ ] `Network Option → Access Authen. Settings` on; credentials read off `Access Authen. Info`
- [ ] Camera has a card in it and is in a mode that can actually record

### B. Network

- [ ] Mac is on the production VLAN
- [ ] `ping <camera-ip>` succeeds
- [ ] Verify link speed on the adapter — a 100Mb negotiation usually means a bad cable, and live view later will suffer

### C. SDK on the Mac

- [ ] Repo cloned, and your shell is `cd`'d into the checkout — not `~`
- [ ] `./scripts/preflight.sh` prints `Preflight OK` — needs only Xcode CLT and CMake 3.24+ (Homebrew optional)
- [ ] SDK placed per [`docs/sdk-install.md`](sdk-install.md) — everything comes from `RemoteCli.zip`
- [ ] `./scripts/check-sdk.sh` prints `SDK layout OK`
- [ ] `cmake -S camd -B camd/build && cmake --build camd/build --target camd-linkcheck`
- [ ] `./camd/build/camd-linkcheck` prints `Camera Remote SDK 2.02.00`

### D. The actual acceptance test

Exact keypress sequence, and the two hardcoded values in Sony's sample that will
stop you: [`docs/remotecli-walkthrough.md`](remotecli-walkthrough.md).

- [ ] `./scripts/patch-remotecli.sh --user <username-from-camera> ~/Downloads/RemoteCli` — required: the sample does not compile on current Xcode and hardcodes the wrong username
- [ ] `./scripts/build-remotecli.sh ~/Downloads/RemoteCli` builds Sony's sample
- [ ] `RemoteCli` accepts the camera by IP, SSH connection = `y`
- [ ] Fingerprint shown by the CLI matches the camera's `Access Authen. Info` screen
- [ ] Connects, using the access-authentication password (username is hardcoded to `admin` — verify that matches the camera)
- [ ] **Starts recording** — confirm the red tally / REC indicator on the camera body itself, not just the CLI's output
- [ ] **Stops recording**
- [ ] Clip is present on the card

---

## What to send me when you run it

Whether it passes or fails, capture:

1. Full terminal output of `./scripts/check-sdk.sh`
2. Full terminal output of `camd-linkcheck`
3. The `RemoteCli` session transcript — especially the connect step and any
   error codes. Sony's `CrError` codes are specific and worth quoting verbatim.
4. Anything in the camera menus that did not match `docs/camera-setup.md`, so I
   can correct the doc.

## Known failure modes, and what they mean

| Symptom | Likely cause |
|---|---|
| Init succeeds, zero cameras found | `CrAdapter/` not at `Contents/Frameworks/CrAdapter` relative to the binary — that path is hardcoded in `libCr_Core.dylib`. Or the camera is not on `USB-LAN Connection`. |
| `libmonitor_protocol.dylib` not found | only `libCr_Core.dylib` was copied; the whole of `external/crsdk/` is required |
| dylib refuses to load, Gatekeeper dialog | quarantine attribute still set — `xattr -dr com.apple.quarantine vendor/CrSDK` |
| Connects, then immediately drops | access authentication mismatch, or camera went to sleep — see camera-setup §6 |
| Ping works, SDK cannot see camera | `Remote Shoot Function` not enabled, or the camera is on a different subnet than it looks |
| Everything works, then dies after a power cycle | `USB-LAN Cnct. Launch` is `Off` (or firmware < 6.00) |

---

## Explicitly not in this phase

No `camd` daemon, no REST, no WebSocket, no Node, no UI. `camd-linkcheck` is
the only code we build, and it deliberately does nothing but load the library.
Phase 1 begins after the record toggle works.
