# Camera portfolio and Wordtandem integration boundary

Updated 2026-09-12. Source: [Sony Camera Remote SDK 2.02 supported cameras](https://support.d-imaging.sony.co.jp/app/sdk/en/index.html).

## What this expansion implements

The application previously centered on an Ethernet-connected FX3/FX30 rig.
It now recognizes 32 Sony SDK model profiles and adopts SDK-discovered USB
cameras without inventing a MAC address. Two cameras of the same model receive
separate saved identities. The registry reconnects an SDK-bound camera only to
that identity; it cannot silently substitute another body by model or IP.
Network cameras retain their existing MAC binding and saved configurations work
unchanged. Unknown future models returned by the SDK are not blocked by a list.

The Setup page includes searchable compatibility information, transport labels,
and model verification status. `/api/camera-support` publishes the same catalog;
`/api/state` and event frames carry per-camera `support` and `capabilities`.
Companion's product list is generated from the catalog and its connections can
supply a configured API bearer token for both commands and live state.

This is application-level compatibility work, not 30 newly hardware-certified
cameras. Sony SDK headers/libraries were not available in the development checkout,
so the changed Sony adapter still needs compilation against SDK 2.02 and real
camera acceptance. The SDK-free daemon, fake backend and application can be
built and tested without those proprietary files.

## Model catalog

Firmware entries are minimums expressly noted in Sony's list, not a promise
that earlier or otherwise unlisted firmware works. Sony directs users to current
firmware. Check the installed SDK's model/interface feature tables before buying
an adapter or choosing USB, Ethernet or Wi-Fi; not every body supports each path.
FX6 variants are represented by one canonical profile with FX6V/FX6T aliases.

| Model | Camera | Family | Minimum firmware | CamBridge validation |
| --- | --- | --- | --- | --- |
| ILME-FX3 | FX3 | Cinema Line | 2.00 | Historical rig use |
| ILME-FX30 | FX30 | Cinema Line | See Sony reference | Historical rig use |
| ILME-FX3A | FX3A | Cinema Line | See Sony reference | Awaiting hardware |
| ILME-FX2 | FX2 | Cinema Line | See Sony reference | Awaiting hardware |
| ILME-FX6 | FX6 | Cinema Line | 3.00 | Awaiting hardware |
| MPC-2610 | BURANO | Cinema Line | See Sony reference | Awaiting hardware |
| ILME-FR7 | FR7 | PTZ | 3.00 | Awaiting hardware |
| BRC-AM7 | BRC-AM7 | PTZ | See Sony reference | Awaiting hardware |
| PXW-Z300 | PXW-Z300 | Camcorder | See Sony reference | Awaiting hardware |
| PXW-Z380 | PXW-Z380 | Camcorder | See Sony reference | Awaiting hardware |
| PXW-Z200 | PXW-Z200 | Camcorder | See Sony reference | Awaiting hardware |
| HXR-NX800 | HXR-NX800 | Camcorder | See Sony reference | Awaiting hardware |
| ILCE-1M2 | Alpha 1 II | Alpha | See Sony reference | Awaiting hardware |
| ILCE-1 | Alpha 1 | Alpha | See Sony reference | Awaiting hardware |
| ILCE-9M3 | Alpha 9 III | Alpha | See Sony reference | Awaiting hardware |
| ILCE-9M2 | Alpha 9 II | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7RM6 | Alpha 7R VI | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7RM5 | Alpha 7R V | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7RM4A | Alpha 7R IVA | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7RM4 | Alpha 7R IV | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7CR | Alpha 7CR | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7SM3 | Alpha 7S III | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7M5 | Alpha 7 V | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7M4 | Alpha 7 IV | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7CM2 | Alpha 7C II | Alpha | See Sony reference | Awaiting hardware |
| ILCE-7C | Alpha 7C | Alpha | See Sony reference | Awaiting hardware |
| ILCE-6700 | Alpha 6700 | Alpha | See Sony reference | Awaiting hardware |
| ZV-E1 | ZV-E1 | ZV | See Sony reference | Awaiting hardware |
| ZV-E10M2 | ZV-E10 II | ZV | See Sony reference | Awaiting hardware |
| DSC-RX1RM3 | RX1R III | Compact | See Sony reference | Awaiting hardware |
| DSC-RX0M2 | RX0 II | Compact | 3.00 | Awaiting hardware |
| ILX-LR1 | ILX-LR1 | Industrial | See Sony reference | Awaiting hardware |

## Control limits

- Exposure, white balance, focus and other mapped property controls are shown
  from the body's reported values and writable flags. A profile does not grant
  ND, lens control, picture settings or other absent hardware capabilities.
- Record requires an explicit idle or recording state before sending a command,
  then exact readback confirmation. Unknown, failed and interval-waiting states
  are refused. The existing FX30-derived Down/start and Up/stop command behavior
  still requires validation on every new body; there is no blind retry.
- Live view and autofocus availability cannot be inferred from a model name;
  their command/frame results remain authoritative. Point focus also needs real
  coordinate validation. Still-photo cameras may require movie mode to record.
- FR7 and BRC-AM7 entries cover the shared SDK camera-control surface. Pan/tilt
  motion and media transfer are not implemented. Do not present these as fully
  featured PTZ controllers.
- SDK device IDs are opaque connection bindings, not portable serial numbers.
  If changing ports, hosts or firmware changes an ID, rediscover and explicitly
  re-adopt that camera. The application must never guess by model instead.
- Canon, Nikon, Panasonic, Blackmagic and generic UVC cameras need separate
  backend adapters. No unsupported brand has been added as a cosmetic entry.

## Reproducible checks

```sh
cmake -S camd -B camd/build -DCAMD_WITH_SDK=OFF
cmake --build camd/build
ctest --test-dir camd/build --output-on-failure
(cd cambridge && npm test)
(cd companion-module-cambridge && npm install --ignore-scripts && npm test)
node scripts/test-camera-portfolio.mjs
```

The portfolio acceptance script uses temporary configuration and loopback ports.
It adopts six mixed-network/USB fake bodies, controls each, checks independent
same-model identities and repeats discovery after a full application/daemon restart.
Synthetic properties do not establish model-specific hardware support.
The completed run passed 64 C++ tests, 184 application tests and 29 Companion
tests. Browser checks passed with no script errors, successful two-body USB
adoption, catalog filtering and no Setup overflow at 390px.

The catalog guard runs with the Node tests. After an intentional catalog update,
run `node scripts/sync-camera-catalog.mjs --write` and review the Companion diff.

For real acceptance: install the licensed SDK manually following `sdk-install.md`,
compile the SDK backend, then verify enumeration, unique IDs, unplug/replug,
power-cycle and restart, lens-dependent writable properties, live view, recording
start/stop and readback on every body/interface/mode being used. Run the existing
hardware kill tests before relying on the expanded rig during a shoot.
Sony's SDK 2.02 page lists macOS 14.1, 15.1 and 26; the old build deployment target
alone is not proof of support on older macOS versions.

## Future Wordtandem integration

Keep Sony SDK ownership and camera credentials in the local CamBridge service.
Wordtandem can consume the versioned catalog and live capabilities, select cameras
by CamBridge ID, and use the existing local REST/SSE API. This change does not
modify Wordtandem's shared prompter or create a second prompter codebase.

Use capability flags to hide unsupported controls, handle disconnected devices,
and show pending or failed commands separately from confirmed camera state.
Do not equate a successful transport request with confirmed recording. Before
production integration, resolve the remaining command-timeout, shared transport,
authentication and take/undo issues identified in the September 12 full audit.
A future provider adapter should implement discovery, identity, property metadata,
commands and status independently; it should not copy Sony-specific command
semantics into another brand. The schema's provider field reserves that boundary.

Companion uses API 1.14.1 and the Node 22 runtime; use Companion 4.2 or newer as
required by [Bitfocus's API compatibility table](https://companion.free/for-developers/module-development/api-changes/).
