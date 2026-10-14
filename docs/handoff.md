# CamBridge — project handoff

Written to be pasted into another assistant, or read by a person picking this up
cold. It is the state of the project, the decisions that are load-bearing, and
what is genuinely unknown — not a feature list.

## What this is

A replacement for Middle Control: a multi-camera control system for Sony cine
bodies, built for one media production company's own use. Not a product, not
redistributed.

**Rig:** 1× Sony FX3 (ILME-FX3), 2× Sony FX30 (ILME-FX30), wired Ethernet over
USB-C→LAN adapters on a dedicated production VLAN at static addresses. Control
machine is an Apple Silicon Mac. Everything runs on the studio LAN; there are no
cloud dependencies and that is deliberate.

**A second venue** has PTZ heads and no cinema bodies: a Panasonic AW-UE160, a
Sony BRC-AM7, a Canon CR-N500 and a PTZOptics Move SE, a SKAARHOJ PTZ Extreme
running Reactor, and Companion — with more heads to come, so it is built for
dozens. See [ptz.md](ptz.md).

## Architecture — the one rule that must not be broken

Two processes:

- **`camd`** — C++ daemon wrapping the Sony Camera Remote SDK 2.02.00. It is
  *thin and dumb*: protocol translation only. Raw SDK values cross its boundary
  untouched. No normalisation, no policy, no interpretation.
- **`cambridge`** — Node server plus a browser panel. Owns **all** business
  logic: value normalisation across bodies, presets, scenes, gangs, match,
  ramping, alarms, undo, auth.

Anything that decides *what a value means* or *whether an action is wise* goes
in cambridge. If a change would put that in camd, it is the wrong change.

**PTZ heads do not go through camd.** No SDK is involved; each head speaks its
own network protocol, and the drivers live in `cambridge/src/ptz/`. The same
split applies inside: drivers are protocol only, and `ptz/lifecycle.js` owns
policy — polling, heartbeat, reconnect, the motion deadman — identically for
every make. A venue with only PTZ heads runs without camd at all (`venue.js`
decides, and the launchers ask it).

Corollaries that have already been tested by real bugs:
- `cambridge` has **zero npm dependencies**. Nothing to install before a shoot.
- Exactly one translation unit includes the SDK headers (`sony_backend.cpp`),
  because the SDK exports unmangled C symbols with names as generic as `Init`
  and `Connect`.
- Per-camera worker threads, so one wedged body cannot touch the others.

## Hard-won findings — do not re-litigate these

**`OnDisconnected` is authoritative; `OnError` is informational.** The FX3 fires
`OnError 0x820A` about 9 ms after every successful connect, while perfectly
healthy. Treating that as a dead link produced 842 teardowns against 8 genuine
disconnects and made every camera unusable. `registry.cpp` now logs and ignores
it. There is a regression test that fails loudly if this is reinstated.

**Access authentication must stay ON.** FX3/FX30 firmware refuses SDK control
over the network when `[Access Authen. Settings]` is off — the cameras connect
and drop in a loop. Passwordless operation is not a feature to add; guidance
recommending it was written once and had to be reversed.

**There is exactly one `Connect()`** in the SDK, with every credential argument
defaulting to null. There is no second overload to reach for.

**The FX30 has no record toggle command.** Record is driven as discrete
Down/Up button events with read-before-write verification.

**Safari does not render `multipart/x-mixed-replace` in an `<img>`.** The
multiview polls single JPEG frames instead of streaming MJPEG. Do not "optimise"
this back into a stream.

**Node's built-in `WebSocket` emits only `error` when a connection is refused —
never `close`.** Scheduling a reconnect solely from the `close` handler meant
cambridge never reconnected after camd restarted, while HTTP kept working so
health checks looked fine.

**CrError groups:** `0x8200` connect, `0x8400` API (the camera is not in a state
that accepts the call), `0x8500` adaptor/transport.

## What is built

Phases 0–5: connection lifecycle, exposure control (iris/ISO/shutter/ND/WB/
tint/focus/zoom/look/monitoring assists), record with verification, presets,
scenes, gangs, match, camera adoption from the UI, live multiview with
tap-to-focus, a macOS app bundle and DMG.

Phase 6: shoot alarms (battery, card, dropped record, offline) with thresholds;
roll verification and a take log; undo and undo-recall; scopes and framing
overlays on the multiview (false colour, clipping marks, histogram, clip %,
thirds/centre/safe/mattes); panel access control (scrypt PINs, operator/admin,
bearer tokens for machine clients, audit trail); ATEM tally; ATEM Link; VISCA
server; gamepad; a Bitfocus Companion module.

PTZ: drivers for all four makes, each built from the maker's protocol document
(notes with page citations) and tested against a protocol simulator built from
the same document; the panel's Operate card, settings sheet with admin section,
presets with pictures, camera bus for big venues, groups, bulk add; Companion
with a selected camera and banks; SKAARHOJ Raw Panel drive mode with banks;
VISCA forwarding to PTZ heads; change-only event stream; `ptz-report.sh` and
`ptz-rehearse.mjs`. An independent review of motion safety, credentials and
admin guardrails was done and its findings fixed, each with a regression test.

**Tests: 60 camd (C++), 338 cambridge (Node), 85 Companion module.**

## Verified on real hardware vs only against the fake backend

Verified on the rig: connection stability, exposure control, record with
verification, presets, scenes, config persistence, app lifecycle, and that
camera 2 refuses a focus point.

**Not verified on hardware** — treat as unproven:
- The `GetImageData()` live-view fix in `sony_backend.cpp`. It compiles only on
  the Mac.
- ATEM Link's packet layout. The Blackmagic *payload* format is published and
  the mapping follows the spec; how an ATEM *wraps* it is community
  reverse-engineering. Ships off by default with a `logRaw` capture mode.
- Card slot 2 and camera temperature. Deliberately absent — they need a grep of
  the CRSDK headers first, because guessing a property name compiles into a
  silent no-op, which is the worst outcome for an alarm.

**PTZ — nothing is verified on a real camera or panel yet.** Everything is
proven against simulators built from the makers' documents, which shows CamBridge
matches our reading of the spec, not that the camera does. `ptz-report.sh` lists
what each camera really answers and which settings are marked *verify*. The
camera-specific checks are in [ptz.md](ptz.md#camera-notes--what-to-check-on-site),
the panel's in [skaarhoj.md](skaarhoj.md).

## Open questions, with the next step for each

1. **Can the FX3/FX30 accept a focus point at all?** Camera 2 answers
   "afAreaPositionAFS is not supported by this body". Run
   `./scripts/focus-report.sh` with Focus Area on **Wide**, then on **Flexible
   Spot**, and diff. If an AF-area property appears only in the second, the
   absence is a mode gate and a tap should switch Focus Area automatically. If
   it never appears, these bodies do not do point focus over the SDK and tapping
   should trigger AF at the camera's own area.
2. **Camera 2 reported zero properties** at one point (`0x8402`, the API group —
   a camera-state problem). Not re-tested since the `onError` teardown fix.
3. **Record-stop took ~10 s.** Not re-measured since the teardown fix.
4. **ATEM tally and VISCA** need real hardware to confirm byte-level variants.
5. **PTZ on site:** run `./scripts/ptz-report.sh --out ptz.txt` with every head
   connected; then work through the *verify* list and the per-camera checks in
   `ptz.md`. On the BRC-AM7, switch on VISCA first (rear SETUP switch 4, admin
   password set).
6. **SKAARHOJ:** whether Reactor and CamBridge can both hold the PTZ Extreme at
   once (the maker's documents disagree), and whether the topology-driven layout
   picks the right controls.

## Method that has actually worked here

Every hard bug in this project was solved by a measurement, not by reading code.
Two speculative fixes were shipped before insisting on a log; the log answered
it in one pass both times. When a test is written for a bug, the bug is
reinstated to confirm the test fails — twice here a test passed with the bug
deliberately restored.

A corollary: the fake backend models what real bodies actually did — the FX3's
missing ND and record toggle, a body with no AF-area property, an `OnError`
after connect, a draining card. A fake where everything works tests nothing.

## Constraints

- **The Sony SDK must never be committed.** It is licensed per-developer.
  `.gitignore` enforces `vendor/CrSDK/*`. Do not attempt to fetch it.
- Camera credentials live only in the git-ignored config at mode 0600.
- The DMG embeds the SDK, so it must stay inside the company.
