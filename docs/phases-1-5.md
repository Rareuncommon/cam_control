# Phases 1–5 — what is proven, and what still needs cameras

Built in one pass rather than gated phase by phase. This document is the honest
accounting: what has actually been verified, and what only the studio rig can
settle.

---

## Verified without hardware

- **51 C++ tests** (`./camd/build/camd_tests`) and **27 Node tests**
  (`cd cambridge && npm test`), all passing.
- `sony_backend.cpp` compiles clean against the real 2.02.00 headers, and every
  SDK symbol it needs is confirmed present in `libCr_Core.dylib`. It has **not**
  been linked — the dylibs are Mach-O, so the first real link happens on the Mac.
- The whole stack run end to end against three simulated bodies: REST, WebSocket
  events, the Node mirror, SSE to the browser, and the control panel.

Run it yourself, no cameras needed:

```sh
./camd/build/camd --config config/cambridge.json --fake &
node cambridge/src/server.js --config config/cambridge.json
```

### Phase 1 — acceptance met

`curl` reads iris and drives record on a camera:

```sh
curl localhost:8787/cameras/cam1/properties
curl -X PUT localhost:8787/cameras/cam1/properties/fNumber -d '{"value":410}'
#   -> {"applied":400,"exact":false,...}  the camera's nearest legal step
curl -X POST localhost:8787/cameras/cam1/actions/recordStart
```

### Phase 3 — acceptance met

A property change reaches the Node mirror well inside the 500ms budget: camd
pushes `propertyChanged` on the WebSocket the moment the SDK reports it, and the
mirror updates before the next SSE tick (60ms coalescing window).

---

## Needs hardware

### Phase 2 — the kill tests

The logic is tested in software, including the isolation guarantee: with one
camera's link pulled, the other two still complete a property write in **33ms**.
Two bugs were found and fixed this way, both of which would have been ugly to
diagnose live:

- A dropped camera let another config entry **steal a surviving camera's body**
  via the model fallback, producing two UI cards pointing at one camera. Matching
  now runs in strength passes — every MAC match resolved before any IP match,
  every IP match before any model match — and an entry that names a MAC never
  falls back at all.
- Once backoff reached its ceiling, a recovered camera **sat idle for the rest of
  the interval** (up to 15s) before retrying, missing the "~10s of link restore"
  target for exactly the power-cycle case that matters. Discovery seeing the body
  return now cancels the backoff; measured rejoin dropped from 15s+ to **2.6s**.

You can rehearse the kill tests without unplugging anything. Under `--fake` only,
camd exposes:

```sh
curl -X POST localhost:8787/debug/link/AA:BB:CC:00:00:02 -d '{"down":true}'
curl -X POST localhost:8787/debug/link/AA:BB:CC:00:00:02 -d '{"down":false}'
```

**Still outstanding, and only real cameras can do it:**

- [ ] Pull a camera's Ethernet mid-session, 5/5, others unaffected
- [ ] Full power-cycle of a body, daemon recovers without restart, 5/5
- [ ] Confirm rejoin within ~10s of link restore on real hardware
- [ ] Confirm `USB-LAN Cnct. Launch → On` really does bring the adapter back at
      power-on (this is what makes the power-cycle test passable at all)

### Phase 4 — your mock service

The panel renders three cameras on an iPad-landscape viewport with no scrolling,
and the recording state is unmistakable. What is untested is a human running a
service with it.

- [ ] Full mock service controlling all three cameras from the browser
- [ ] Check on the actual booth iPad, not a simulated viewport
- [ ] Confirm the recording indicator is readable at a glance in a dim room

### Phase 5 — you define these

Working under simulation: presets save and recall; scenes recall all three
concurrently and report cameras skipped for being offline; gang applies with
per-camera step offsets (an FX3 at f/8.0 drove a linked body to f/7.1 at −1);
match copies exposure and colour and **flags ISO as approximated** across sensor
sizes rather than pretending it is exact.

- [ ] Your acceptance tests, once you have decided what they are

---

## Open questions only hardware can answer

1. **Property value lists.** camd reads each property's value array generically
   from the SDK's element width. What is not distinguishable from the headers is
   whether a 3-element list means three legal values or a min/max/step triple.
   The daemon reports what it is given; check a real body's `fNumber` and
   `colorTemp` against the camera's own menu.
2. **Encodings marked CONFIRM in `cambridge/src/normalise.js`.** f-number (×100)
   and shutter (numerator<<16 | denominator) are taken from Sony's own parsing.
   The ISO mode byte and the white-balance preset ordering are inferred and
   should be checked against the camera's menu.
3. **Focus.** Whether your lenses report an absolute `focusPosition`, and what
   step size `NearFar` actually moves. The UI exposes both and disables the
   absolute slider when the property is not writable.
4. **`CrCommandId_MovieRecButtonToggle2`.** An undocumented second toggle variant
   exists in the headers. If the FX30 supports it, record could skip the
   read-before-write dance entirely.
5. **Media and battery property codes.** `MediaSLOT1_RemainingTime` and
   `BatteryRemain` are plausible but unconfirmed; the status line will show
   whatever they actually return.

## First hardware bring-up

```sh
git pull
./scripts/preflight.sh
./scripts/check-sdk.sh
cmake -S camd -B camd/build && cmake --build camd/build
./camd/build/camd-linkcheck          # unchanged from Phase 0
cp config/cambridge.example.json config/cambridge.json   # fill in MACs + credentials
./camd/build/camd --config config/cambridge.json --verbose
```

Start with **one** camera in the config. `GET /discovered` lists every body on
the network with its MAC, which is the easiest way to fill the config in:

```sh
curl localhost:8787/discovered
```

Send me the `--verbose` log from the first connect attempt. The interesting part
is what `getProperties` returns for a real FX30 — that answers most of the open
questions above in one go.
