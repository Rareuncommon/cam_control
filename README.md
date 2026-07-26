# CamBridge

Multi-camera control for Sony cinema bodies over wired Ethernet. Built for one
church studio, one operator, three cameras. Internal use only — not for
redistribution.

**Cameras:** 1× ILME-FX3, 2× ILME-FX30
**Transport:** USB-C → gigabit Ethernet adapters (RTL8153 / AX88179), dedicated
production VLAN, static IPs
**Control machine:** Apple Silicon Mac, macOS 26

---

## Current status

**Phase 0 — environment and SDK bring-up.** Nothing controls a camera yet. The
repo is scaffolded and the Phase 0 acceptance test is written but not yet run
against hardware.

Next action is yours, at the machine: work through
[`docs/phase-0-acceptance.md`](docs/phase-0-acceptance.md).

| Phase | Scope | Status |
|---|---|---|
| 0 | Toolchain + SDK + one camera over Ethernet via Sony's own sample | scaffolded, awaiting hardware test |
| 1 | `camd` core — single camera, property get/set, record, over REST | not started |
| 2 | Multi-camera + connection lifecycle; kill tests 5/5 | not started |
| 3 | WebSocket events + Node bridge with mirrored state | not started |
| 4 | Web control panel, laptop + iPad landscape | not started |
| 5 | Presets, scenes, gang control, match mode | not started |
| 6+ | Multiview, Companion, ATEM tally, Q-SYS | backlog, not built |

Phases are strictly sequential: no phase begins until the previous one's
acceptance test passes on real hardware.

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

The daemon is the part that must never die during a service. Keeping it free of
features means the code that has to survive a camera vanishing mid-song is
small enough to reason about completely. Everything that changes often lives in
the layer written in the language this repo's author actually enjoys debugging
at 9am on a Sunday.

---

## Setup, from cold

1. **Cameras** — configure each body per [`docs/camera-setup.md`](docs/camera-setup.md).
   Read the access-authentication credentials off each one while you are there.
2. **SDK** — download and place the Sony Camera Remote SDK per
   [`docs/sdk-install.md`](docs/sdk-install.md). It is licensed per-developer
   and is never committed to this repo.
3. **Config** — `cp config/cambridge.example.json config/cambridge.json` and
   fill in IPs, credentials, and ports. The real file is git-ignored because it
   holds camera passwords.
4. **Verify** — `./scripts/check-sdk.sh`, then build and run `camd-linkcheck`.
5. **Phase 0 test** — [`docs/phase-0-acceptance.md`](docs/phase-0-acceptance.md).

---

## Repo layout

```
camd/            C++ control daemon (Phase 1+); today, only the linkcheck tool
cambridge/       Node.js app server + web UI (Phase 3+); scaffold only
config/          single editable config file; real one is git-ignored
docs/            SDK install, camera setup, per-phase acceptance tests
launchd/         macOS service definition for camd
scripts/         SDK verification and Sony sample-app build helpers
vendor/CrSDK/    where the Sony SDK goes; git-ignored except the placement guide
```

---

## Operating principles

Carried from the project brief. These override convenience.

- **Reliability over features.** This runs Sunday services.
- **Fail loud in the UI, fail soft in the daemon.** A camera dropping is a
  banner in the browser, never a crashed process.
- **One dead camera affects nothing else.** Non-negotiable, and the thing
  Phase 2's kill tests exist to prove.
- **Everything logged, timestamped, rotating.** Postmortems happen on Monday.
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
