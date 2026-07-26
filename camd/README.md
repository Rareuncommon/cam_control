# camd — Sony camera control daemon

C++ daemon wrapping the Sony Camera Remote SDK. Holds persistent connections to
all three bodies and exposes a REST + WebSocket API on loopback.

**Status: Phase 0.** The only thing built here today is `camd-linkcheck`, a
toolchain proof. The daemon itself is Phase 1 and starts after the Phase 0
acceptance test passes on real hardware.

## Design rules

These are load-bearing. Later phases should not erode them.

1. **Thin and dumb.** `camd` is a protocol translator. No presets, no gang
   logic, no matching, no normalisation between FX3 and FX30. It reports raw
   SDK values and applies raw SDK values. All business logic lives in
   `cambridge`.
2. **Fail soft.** A camera that vanishes must never take down the process or
   block the other two. Per-camera state machines, per-camera threads,
   no shared mutable state that a dead camera can hold a lock on.
3. **Fail loud upward.** Soft failure in the daemon means the *daemon* keeps
   running — not that problems get swallowed. Every degraded state is pushed to
   `cambridge` so the UI can shout about it.
4. **Report actual applied values.** `PUT` on a property returns what the
   camera actually accepted, which is frequently not what was asked for
   (nearest legal step, or refused outright in the current mode).

## SDK facts, verified against 2.02.00

Checked directly against the shipped headers and dylibs, not assumed:

- **The API is `extern "C"` inside `namespace SCRSDK`.** It exports unmangled
  global symbols — `Init`, `Release`, `Connect`, `EnumCameraObjects`,
  `SetDeviceProperty`, `SendCommand`. Confirmed present in `libCr_Core.dylib`.

  Consequence for Phase 1: those are extremely generic names in the global C
  symbol namespace. If we link a second library that also exports a C symbol
  called `Init` or `Connect`, the collision resolves silently at load time and
  the failure will look like the SDK misbehaving. Keep `camd`'s third-party
  dependencies minimal, and always call through the `SCRSDK::` qualifier so the
  intent is unambiguous in our own source.

- **Transport adapters load from `Contents/Frameworks/CrAdapter`**, a relative
  path hardcoded in `libCr_Core.dylib`. Not `./CrAdapter`. Handled by
  `crsdk_stage_runtime()` in `cmake/FindCrSDK.cmake`.

- **`libmonitor_protocol.dylib` and `libmonitor_protocol_pf.dylib`** must sit
  beside `libCr_Core.dylib`; the core references them by name.

- **All shipped dylibs are universal (`x86_64` + `arm64`)** — native on Apple
  Silicon. Sony builds them against macOS deployment target 12.1, which we match.

- **OpenCV is not needed.** Only Sony's `RemoteCli` sample links it, to display
  live view in a desktop window. We relay JPEG frames instead.

## Discovery and camera identity — confirmed on hardware

`SDK::EnumCameraObjects()` **auto-discovers cameras on the LAN**. Observed
finding an FX30 over wired Ethernet and self-reporting its model and real MAC
address without being told an IP.

Each enumerated `ICrCameraObjectInfo` exposes everything the daemon needs to
identify and connect a body:

| Accessor | Use in `camd` |
|---|---|
| `GetMACAddress()` / `GetMACAddressChar()` | **stable per-body identity** |
| `GetIPAddress()` / `GetIPAddressChar()` | current address, may change |
| `GetModel()` | FX3 vs FX30, straight from the camera |
| `GetSSHsupport()` | whether access authentication is on |
| `GetAuthenticationState()` | auth progress/state |
| `GetPairingNecessity()` | whether pairing is required |
| `GetConnectionStatus()` | connection state |
| `GetGuid()`, `GetName()`, `GetAdaptorName()` | diagnostics and logging |

Design consequences for Phase 1 and 2:

- **Key cameras by MAC, not IP.** The SDK identifies networked bodies by MAC, and
  it is the one identifier that survives an address change. Config still pins
  static IPs — that is good practice and makes the network debuggable — but the
  daemon should match discovered cameras to config entries by MAC and treat the
  IP as informational. This matters directly for Phase 2: a camera that comes
  back on a different address must still be recognised as the same camera.
- **Do not hand-build camera objects from config IPs.** Sony's sample has a
  second, `#ifdef`-disabled path that constructs a camera from a model hint plus
  IP plus MAC. It requires guessing the model up front — and its default guess
  is wrong for us. Enumeration reports the truth instead. Prefer it.
- **Never assume a model.** `GetModel()` is authoritative. The FX3/FX30
  distinction drives value normalisation in `cambridge`, so it must come from
  the camera rather than from config that can drift.
- **Access authentication is discoverable**, not something to configure blind:
  `GetSSHsupport()` tells us whether a body expects credentials before we try.

## Build

Requires the Sony SDK vendored first — see [`docs/sdk-install.md`](../docs/sdk-install.md).

```sh
./scripts/check-sdk.sh
cmake -S camd -B camd/build -DCMAKE_BUILD_TYPE=Debug
cmake --build camd/build --target camd-linkcheck
./camd/build/camd-linkcheck
```

## Layout

```
camd/
├── CMakeLists.txt
├── cmake/FindCrSDK.cmake   locates the vendored SDK; stages CrAdapter/
├── tools/linkcheck.cpp     Phase 0 toolchain proof
├── include/camd/           (Phase 1)
└── src/                    (Phase 1)
```

## Planned API

Sketched in the project brief, restated here so it is versioned alongside the
code. Subject to refinement in Phase 1.

**REST**

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/cameras` | list: connection state, model, IP |
| `GET` | `/cameras/:id/properties` | current values + valid ranges/steps |
| `PUT` | `/cameras/:id/properties/:prop` | set; returns actual applied value |
| `POST` | `/cameras/:id/actions/:action` | `recordStart`, `recordStop`, `autofocus`, `reconnect` |
| `GET` | `/cameras/:id/liveview` | MJPEG stream / single frame |

**WebSocket** (`/ws`, push only)

| Event | Payload |
|---|---|
| `propertyChanged` | `{cameraId, prop, value}` |
| `connectionState` | `{cameraId, state}` — `connected` / `reconnecting` / `offline` |
| `statusUpdate` | `{cameraId, battery, media, recording}` |

**Focus** is exposed both ways, per decision at project start: an absolute
position property *and* a relative nudge action. Lens support for absolute
positioning varies, so `cambridge` picks per lens and falls back to relative.
Presets can only store focus on lenses that report absolute position — the UI
needs to say so rather than silently recalling nothing.
