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
