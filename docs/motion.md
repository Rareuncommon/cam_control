# Camera motion: the phone app's Motion tab

The CamBridge phone app's **Motion** tab drives an edelkrone **HeadONE** and
**SliderPLUS v6** directly over Bluetooth, from the phone. It does not go
through the Mac. It is Slidercontrol's app
(`github.com/Rareuncommon/Slidercontrol`, `main` at `cea6b83`), built on a
Dart port of edelkrone's own SDK, brought into this app as a Flutter module
and updated to SDK 0.1.1.

**It has not been run on the rig.** Everything here is tested against a
simulated HeadONE and slider, and against vectors recorded from edelkrone's
Python SDK. **Take the camera off the rig before you test anything that
moves.**

- [Safety](#safety)
- [Using it](#using-it)
- [How it sits in the app](#how-it-sits-in-the-app)
- [The SDK port, and the move to 0.1.1](#the-sdk-port-and-the-move-to-011)
- [Building](#building)
- [Tests](#tests)
- [Known limits and open questions](#known-limits-and-open-questions)

## Safety

These rules come from Slidercontrol and are kept as they were:

- **Every way out stops first.**
  - **STOP ALL:** on the Motion tab, and in a red bar on every other screen
    while a rig is connected, the pairing screen included.
  - **Escape** on a keyboard, from any screen.
  - **The app going to the background or being hidden, or closing.** These
    are caught by the app whichever tab is showing, and by the module
    itself.

  All of them go through the module's `StopRegistry`, so they stop the
  joystick, a recall and the head's own loop alike. The SDK's stop goes to
  the front of the command queue and never throws.
- **A stop also cancels a move that has not been sent yet.** Three pieces do
  this, and none may be removed:
  - the stop counter, `Device._stops`;
  - `EdelkroneSession.sendUnlessCancelled`, which checks that counter when a
    queued move's turn comes;
  - the controller's check that drops a recall or loop that was waiting for
    earlier motion to stop when STOP ALL was pressed.
- **Nothing is homed.** The head has no end stops and is never driven to find
  one. The slider finds its own position when it powers on.
- **For anything unattended, pose recalls are used, not streamed joystick
  speed.** The loop with no pause is the head's own loop, a single command it
  runs until stopped. The joystick is hold-to-move, and the device stops by
  itself 1.5 s after the last joystick command.
- **Focus gate.** Motion (the joystick and every pose call) is refused while
  the head reports a focus motor, unless it also reports both of these:
  - the motor referenced (`focusModuleIsBrushlessCalibrated`);
  - the lens ends found (`isSimpleFocusCalibrationDone`).

  Set the lens up in the edelkrone app, or disconnect the focus motor. The
  SDK's focus setup, which turns the lens, is not ported.
- **No invented bytes.** Every frame that drives a motor comes from the SDK:
  - the codecs are generated from it;
  - the session layer is ported from it by hand and checked against vectors
    recorded from it.

## Using it

Open **Motion**, then:

1. **Scan.** The app asks for "Nearby devices" if it does not have it, finds
   the edelkrone units, and groups them into rigs the way the SDK does. The
   list keeps the order units were first found in, so entries don't swap
   places as their signals change. Signal shows as bars; long-press for dBm.
2. **Pair the head and slider.** A head and a slider it can join show first,
   as one **Rig** card. Press **Connect head + slider**, then **Join and
   connect**. (**HeadONE only**, or tapping a unit in the list below, connects
   it on its own.) If a head and slider are in sight but the SDK won't join
   them, the head's card says why, from what the units advertise. Send that
   line if you see it. Joining forms a wireless layout:
   - the head keeps its group;
   - it takes the layout configuration;
   - it invites the slider by MAC address;
   - the app adopts the setup the head reports.

   From then on the head plans every pose move so both axes arrive together.
   The layout lasts until a unit is switched off. Switching a unit off also
   deletes the poses stored on the head.

   **Reopening the app** finds the rig already joined and shows it as a
   **Rig · already joined** card with a **Connect** button. The app also
   connects to the last rig by itself when it's in sight in the same state
   it was left in: joined if it was joined, on its own if it was on its own.
   It does this only while the app is on screen, and it never joins anything
   by itself (a join lasts until power-off, so that is always your call).
   Connecting moves nothing. Pressing **Disconnect** makes the app forget the
   rig, so it won't reconnect until you connect it again.
3. **Control page.** One screen, no scrolling, upright or on its side:
   - **Live position:** pan or tilt in degrees and slide in cm, updated every
     0.25 s, plus battery. These warnings show when they apply:
     - firmware below the SDK minimum;
     - the slider not answering the head;
     - an orientation warning;
     - a focus motor that is not set up.
   - **Jog pads,** one per axis. Holding a pad sends
     a command every 100 ms; releasing it stops at once. Grabbing a pad during
     a loop or a recall stops that first.
   - **Twelve pose slots, stored on the head.**
     - **Save** uses the next free slot. An empty slot between stored poses
       shows as a warning tile so it can be filled again: a move through an
       empty slot stops there.
     - **Tap a pose to go there.** Arrival is checked against the reported
       position, within 0.25° and 0.25 cm. A move passes through every pose
       stored in between.
     - **Hold a pose** to rename it, replace it with the current position, or
       delete it. Names are kept on the phone, per rig.
   - **Speed, accel and jog** tiles, each showing its value. Tap one for a
     full-width slider and presets (10, 25, 50, 75, 100%). Speed and accel
     apply to every pose move; jog is the pads' top speed.
   - **Loop** between two poses.
     - With no pause, it is the head's own loop: one command it runs until
       stopped.
     - With a pause, the app runs each leg as a checked move, then waits.
   - **STOP ALL · Esc.**
   - **Reconnect** after a dropped link.
   - **The SDK's log,** one tap away, with a copy button.

The rig **stays connected when you switch tabs**. A move or the head's loop
keeps running while you start recording on the Cameras tab, and the red
STOP ALL bar is there the whole time.

**Back** leaves the app, as on the other tabs. Leaving stops and disconnects
the rig. To leave just the control page, use its own disconnect button.

## How it sits in the app

```
 CamBridge app (Kotlin, Compose)                 Motion module (Flutter, mobile/motion)
 ───────────────────────────────                 ──────────────────────────────────────
 Motion tab ── FlutterFragment, cached engine ─► scan page, control page (Slidercontrol)
 STOP ALL bar, Escape, background, close            │
     └── MethodChannel studio.cambridge.motion/host ─► HostLink ─► StopRegistry.stopAll()
 "Nearby devices" permission ◄── requestBluetooth ──┘           RigController ─► SDK port ─► BLE
```

- `MotionBridge` (app) starts the module's engine the first time the tab
  opens and keeps it for the app's life.
- `MainActivity` lays the module's view over the Motion tab, and hides it
  (still attached) while another tab shows. It is not recreated on rotation,
  because detaching the module would stop the rig.
- `MotionStops` (app) is the app's side of the stops: background or hidden
  sends `stopAll`; closing sends `stopAll`, then `disconnect`; Escape sends
  `stopAll`.
- `HostLink` (module) answers those calls through the same `StopRegistry` as
  the module's own STOP ALL, and reports to the app whether a rig is connected
  and moving, for the STOP ALL bar.
- **Bluetooth permission** is requested by the app, which already asks for
  "Nearby devices" for its own link to the Mac and lists it under Settings ›
  Permissions. Slidercontrol used `permission_handler`. The app requires
  Android 13, where `BLUETOOTH_SCAN` (declared never-for-location) and
  `BLUETOOTH_CONNECT` are all that is needed, so the legacy permissions and
  location for older Android versions never apply.
- **On its side,** the app's tabs move to a side rail and its top bar steps
  aside on this tab, so the control page gets the full height. The pose grid
  sizes its tiles to the space it is given, so all twelve always fit without
  scrolling.

## The SDK port, and the move to 0.1.1

`mobile/motion/lib/sdk` is Slidercontrol's Dart port of the edelkrone SDK
(MIT; `lib/sdk/LICENSE`):

- **Generated (never edit by hand):** the codecs in `protocol/generated/`
  and the model table, both produced by `tool/sdk_port/`.
- **Hand-ported** following the SDK's structure: the session, devices,
  motion and API layers.
- **Transport:** `FlutterBlueTransport`, over flutter_blue_plus.

It is now on **edelkrone SDK 0.1.1** (PyPI, published 21 October 2026; wheel
sha256 `77353c1e…`), as asked:

1. **The tools reproduce the old port.** Slidercontrol's generators, run on
   0.1.0, reproduce its committed codecs, models and vectors byte for byte.
   The tools are sound.
2. **Codecs regenerated from 0.1.1.** The only additions are point-mode
   commands and enums. No existing frame changed, so every byte that drives a
   motor today is the same.
3. **Vectors re-recorded with the 0.1.1 Python SDK:**
   - 6,336 codec calls over 132 functions;
   - 107 commands, 898 layout decisions, 300 rig groupings and 600 status
     frames.
4. **Hand-ported, following 0.1.1's own code:**
   - the status and position polls take turns rather than holding each other
     off;
   - a FocusPLUS PRO counts as a focus motor;
   - in point mode:
     - pose calls are refused and stored slots read empty;
     - a stop cuts a turn towards a point short (`targetTransitionAbort`)
       rather than aborting a planned move;
     - the joystick on a held point sends `targetShift`;
   - `slide_fraction` is always null.
5. **Not ported:** the rest of point mode, and the focus setup that turns the
   lens. The app does not use them.
6. **The focus gate is kept stricter than 0.1.1, deliberately.**
   - 0.1.1 gates only the pose calls, only on the lens ends, and asks for the
     motor reference only on a HeadPLUS V3 or V3 PRO with the focus module.
   - This port still refuses the joystick and the pose calls unless the head
     reports both the motor referenced and the lens ends found, as the safety
     rules require. See the open questions below.

To update to a later SDK, from `mobile/motion`, with the SDK installed in a
virtualenv and `G` pointing at its `edelkrone/protocol/_generated/`:

```bash
python3 -I tool/sdk_port/py2dart.py lib/sdk/protocol/generated <sdk-version> $G/moco.py $G/head_module_util.py $G/slide_module_util.py $G/head_module.py $G/slide_module.py
python3 -I tool/sdk_port/gen_models.py
python3 -I tool/sdk_port/gen_vectors.py $G
gzip -9n -f test/sdk/vectors/codec_vectors.json
python3 -I tool/sdk_port/gen_session_vectors.py
```

Use the virtualenv's `python3`, so that the generators import the SDK.

Then compare the new SDK's hand-ported layers with the old ones, port what
changed, and run the tests.

## Building

The module is built into Android libraries that the app links. The Mac setup
is in [mobile-app.md](mobile-app.md#set-up-the-mac-to-build-it): add
`flutter` to the `brew install`. It was tested with Flutter 3.47.9 (Dart
3.13.7). From `mobile/motion`:

```bash
flutter build aar --no-profile --target-platform android-arm64 --build-number 1
```

Then build the app from `mobile/` as usual. If the libraries are missing, the
app's build stops with this command; if `mobile/motion` has changed since they
were built, it warns. The libraries are built for 64-bit ARM only, which
covers the Pixel 9a and current Android phones. The release APK is about
22 MB, most of it the Flutter engine.

## Tests

From `mobile/motion`:

```bash
dart test
flutter test test_widget
flutter analyze
```

- **`dart test`** (50 tests):
  - **Slidercontrol's 43:**
    - every codec call against the recorded vectors;
    - every command, layout decision, rig grouping and status frame against
      the session vectors;
    - the session's behaviour against the simulated HeadONE and slider:
      queue priority, the stop order, joins, poses, loops, a stop cancelling a
      queued move, and the focus gate;
    - the controller;
    - the stop registry.
  - **Seven for 0.1.1:** the FocusPLUS PRO gate, point mode (refused poses,
    the stop, the joystick on a held point), and the polls taking turns. Each
    fails against the 0.1.0 code it replaces, except the two that hold under
    both.
- **`flutter test test_widget`** (24 tests):
  - Slidercontrol's control page at six full-screen sizes;
  - the control page at the Motion tab's real sizes, with three and with
    twelve poses, checking that nothing overflows or scrolls:
    - Pixel 9a, small phone, large phone and tablet, upright;
    - Pixel 9a, small phone and tablet, on their side;
  - the host link: the app's STOP ALL stops the head's own loop; closing
    stops, then lets go; the rig reaches the app; an unknown call is refused.
- **Pictures:** `MOTION_SCREENSHOTS=<dir> flutter test test_widget/screenshots_test.dart`
  renders the control page and the scan page to PNG with real fonts.

The app side (`mobile/`, `./gradlew :app:testDebugUnitTest`) tests the stops
it owns, the rig reports, and the STOP ALL bar.

Slidercontrol's `ek_protocol.dart` (the reverse-engineered client, kept there
as the capture record and not used by its app) is not brought here, so its
41 tests stay in Slidercontrol.

## Known limits and open questions

- **Not tested on the rig.** Scanning, joining, and the timing of jogs and
  stops have only met the simulator. **Take the camera off the rig first.**
- **Focus gate on a HeadONE.** SDK 0.1.1 says the motor reference
  (`focusModuleIsBrushlessCalibrated`) is only taken by a HeadPLUS V3 or
  V3 PRO with the focus module. If a HeadONE with a focus motor never reports
  it, the strict gate refuses motion for as long as the motor is connected.
  Whether it does is unknown until the rig is tried. Please report what the
  head shows; the gate is not loosened without your say-so.
- **flutter_blue_plus licence.** Connections declare `License.nonprofit`, as
  in Slidercontrol. That covers personal, nonprofit and educational use. For
  use by or for a for-profit company, including development and testing, the
  licence asks for a commercial licence:
  - One-time, per organisation, covering all its apps and all versions.
  - $2,999 USD as listed in November 2026, with tiers by employee count. The
    shop showed it as sold out then.
  - Bought through `jamcorder.myshopify.com/products/flutterblueplus-commercial-license`;
    contact `chipweinberger@jamcorder.com`.

  The declaration is in `lib/sdk/transport/flutter_blue_transport.dart`.
- **iOS** is not built. The module could be embedded in an iOS app later; that
  app would need `NSBluetoothAlwaysUsageDescription` in its `Info.plist`.
- **Back** on the Motion tab leaves the app, which stops and disconnects the
  rig, rather than stepping from the control page back to the scan page.
