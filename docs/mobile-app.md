# The CamBridge phone app (Android)

The app controls the studio from a phone: cameras (record, exposure,
autofocus) and lighting (looks, faders, colour presets, scenes). It talks to
CamBridge on the Mac over the studio Wi-Fi, and falls back to Bluetooth
through a small bridge on the same Mac when the Wi-Fi drops.

Its **Motion** tab drives an edelkrone HeadONE and SliderPLUS directly over
Bluetooth, with no Mac involved; that is in [motion.md](motion.md).

It is sideloaded with `adb`. There is no Play Store listing. It runs on
Android 13 and later and is built for Android 17. It has been tested against
CamBridge with simulated cameras, but not yet on a real phone in the studio.

- [How it fits together](#how-it-fits-together)
- [Set up the Mac to build it](#set-up-the-mac-to-build-it)
- [Build, sign and install](#build-sign-and-install)
- [Pair a phone, and revoke one](#pair-a-phone-and-revoke-one)
- [The Bluetooth bridge](#the-bluetooth-bridge)
- [Try it without the studio](#try-it-without-the-studio)
- [Using it](#using-it)
- [Security, and its limits](#security-and-its-limits)
- [Troubleshooting](#troubleshooting)
- [For developers](#for-developers)

## How it fits together

```
 Phone app ── Wi-Fi: signed REST + event stream ─────────────┐
     │                                                       ▼
     └──── Bluetooth LE ──► blebridge (Swift, launchd) ──► CamBridge ──► camd ──► cameras
                            Unix socket, newline JSON        │
                                                             └──► sACN ──► lights
```

- **One API.** The app sends the same REST calls the browser panel and
  Companion use. Live state is CamBridge's own event stream: a full frame
  first, then change-only patches. Bluetooth carries the same requests and
  the same frames, compacted and sealed (see [ble-protocol.md](ble-protocol.md)).
- **Wi-Fi first.** The app switches to Bluetooth once Wi-Fi has been down for
  3 seconds. It switches back once Wi-Fi has been steady for 5 seconds, and
  keeps Bluetooth up for another 30 seconds in case Wi-Fi drops again. Every
  switch starts again from a full frame, so the screen never shows a guess.
- **Server-confirmed.** Every value on screen is CamBridge's. A command marks
  its control as pending until CamBridge answers, and that answer decides the
  haptic: a tick when it worked, a buzz when it was refused.
- **Capability-driven.** The screens follow what CamBridge reports. A camera
  shows only the controls it has. Values on Auto show as Auto. The Lighting
  tab appears only when CamBridge has lighting.
- **The bridge stays thin.** blebridge only moves bytes between Bluetooth and
  a socket that CamBridge owns. Authentication, encryption, rate limits and
  every decision happen in CamBridge (`cambridge/src/ble/gateway.js`).

Where things are:

| Part | Path |
|---|---|
| Android app | `mobile/app` (Kotlin, Jetpack Compose) |
| Protocol, model and transport switching, with no Android code | `mobile/core` |
| Shared test vectors, checked by Node and Kotlin | `protocol/vectors/v1.json` |
| Bluetooth bridge | `blebridge/` |
| Pairing, signatures and revocation on the server | `cambridge/src/devices.js` |
| Bluetooth gateway on the server | `cambridge/src/ble/` |
| Simulated studio for testing | `scripts/mock-studio.mjs` |

Identifiers: the app is `studio.cambridge.mobile`, and the bridge and its
launch agent are `studio.cambridge.blebridge`.

## Set up the Mac to build it

You need this once. It installs a JDK, the Android command-line tools and
`adb`:

```bash
brew install --cask temurin@21 android-commandlinetools android-platform-tools flutter
```

Flutter builds the Motion tab ([motion.md](motion.md)). It was tested with
Flutter 3.47.9 (Dart 3.13.7); `flutter --version` shows yours.

Then the Android SDK parts the app builds against. The second command shows
Google's SDK licences one by one; read them and answer `y` to accept:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
```

Add `export ANDROID_HOME="$HOME/Library/Android/sdk"` to `~/.zshrc` so later
terminals have it. Gradle itself comes with the repository
(`mobile/gradlew`) and downloads what it needs on the first build.

Check it worked:

```bash
java -version
adb version
```

## Build, sign and install

### A signing key, once, outside the repository

Android installs only signed apps. An update must be signed with the same key
as the version already installed, so make one key and keep it. The key and its
password never go in the repository: `.gitignore` refuses `*.jks`,
`*.keystore` and `keystore.properties` in `mobile/`.

```bash
mkdir -p "$HOME/.cambridge-signing"
chmod 700 "$HOME/.cambridge-signing"
keytool -genkeypair -v -keystore "$HOME/.cambridge-signing/cambridge-release.jks" -alias cambridge -keyalg RSA -keysize 4096 -validity 10000 -dname "CN=CamBridge"
```

`keytool` asks for a password. Back up the `.jks` file and its password
somewhere safe, such as a password manager. Without it, the next version
cannot be installed over this one. You would have to uninstall the app,
which forgets its pairing, and pair again.

### Build and sign

From the repository:

```bash
cd mobile/motion
flutter build aar --no-profile --target-platform android-arm64 --build-number 1
cd ..
./gradlew :app:assembleRelease
"$ANDROID_HOME/build-tools/36.0.0/apksigner" sign --ks "$HOME/.cambridge-signing/cambridge-release.jks" --ks-key-alias cambridge --out cambridge.apk app/build/outputs/apk/release/app-release-unsigned.apk
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --print-certs cambridge.apk
```

- `flutter build aar` builds the Motion tab into Android libraries the app
  links. Run it again after changing anything in `mobile/motion`; the app's
  build warns when it is out of date, and stops with this command when it is
  missing.
- `./gradlew :app:assembleRelease` builds a shrunk release (about 22 MB, most
  of it the Flutter engine) without signing it.
- `apksigner sign` asks for the key's password and writes `cambridge.apk`.
- `apksigner verify` shows the certificate it was signed with.

`mobile/cambridge.apk` is ignored by git through `*.apk`. Do not commit it.

**Alternative: let Gradle sign it.** Set `CAMBRIDGE_KEYSTORE`,
`CAMBRIDGE_KEYSTORE_PASSWORD` and (if different) `CAMBRIDGE_KEY_ALIAS` and
`CAMBRIDGE_KEY_PASSWORD`, either as environment variables or in
`~/.gradle/gradle.properties`. Then `./gradlew :app:assembleRelease` writes
`app/build/outputs/apk/release/app-release.apk`, already signed.
`~/.gradle/gradle.properties` is outside the repository, but it keeps the
password in a file. The `apksigner` route above does not.

### Install with adb

On the Pixel 9a, once:

1. Open **Settings › About phone** and tap **Build number** seven times.
2. Open **Settings › System › Developer options** and turn on **USB debugging**.
3. Connect the phone by USB and accept the "Allow USB debugging?" prompt.

Then:

```bash
adb devices
adb install -r cambridge.apk
```

- `adb devices` should list the phone as `device`. If it says `unauthorized`,
  accept the prompt on the phone.
- `-r` installs over an earlier version and keeps its pairing and settings.

Apps installed with `adb` are exempt from Android's developer-verification
requirement for sideloaded apps. No Play Console account is needed.

To install over Wi-Fi instead of USB, use **Developer options › Wireless
debugging › Pair device with pairing code**, then:

```bash
adb pair PHONE_IP:PAIRING_PORT
adb connect PHONE_IP:PORT
adb install -r cambridge.apk
```

The IP and ports are the ones the Wireless debugging screen shows.

## Pair a phone, and revoke one

1. In CamBridge on the Mac, open **Setup › Phones › Pair a phone**. A QR code
   appears. It works once, for ten minutes, and closing the dialog cancels it.
2. Open the app and point the phone at the code. If the camera cannot read the
   screen, use **Copy link** in the dialog and paste the link into the app
   instead. The link holds the phone's key, so send it only to your own phone.
3. The app connects, and CamBridge shows the phone as **paired**, with its
   name and model.

On the phone, pairing imports the key into the **Android Keystore** as a
non-exportable key. The app can sign with it, but nothing can read it back:
not the app, not a backup (the app opts out of backups), and not `adb`.

**Revoke** a phone in **Setup › Phones**. It stops at once, on Wi-Fi and
Bluetooth: its live stream is closed, its next request is refused, and its
Bluetooth session ends. The app then shows "no longer knows this phone",
deletes its key and goes back to the pairing screen. To bring the phone back,
pair it again.

**Forget** (in the app's Settings) is the phone's side: it deletes the key from
the phone. Also revoke the phone in Setup if it is leaving the studio.

## The Bluetooth bridge

Bluetooth needs `blebridge` running on the Mac. It is a small Swift program,
run by launchd as your user, so it starts at login and restarts if it stops.
Build and install it from the repository:

```bash
scripts/install-blebridge.sh
```

The first time, macOS asks to allow Bluetooth for "blebridge". Allow it.
Check it:

```bash
"$HOME/Library/Application Support/CamBridge/bin/blebridge" --check
tail -f "$HOME/Library/Logs/CamBridge/blebridge.log"
```

**Where CamBridge expects the bridge.** CamBridge listens on a socket beside its
config:

- started from CamBridge.app: `~/Library/Application Support/CamBridge/blebridge.sock`.
  This is the installer's default.
- started with `scripts/start.sh`: `config/blebridge.sock` in the repository.
  Install the bridge pointing there instead, from the repository:

```bash
CAMBRIDGE_BLE_SOCKET="$(pwd)/config/blebridge.sock" scripts/install-blebridge.sh
```

To use some other path, set `cambridge.ble.socket` in `cambridge.json`. To
turn Bluetooth off in CamBridge, set `cambridge.ble.enabled` to `false`.

**The Bluetooth permission and rebuilds.** macOS ties the permission to the
binary's signature. The installer signs ad hoc by default, which changes with
every build, so each reinstall asks again. Signing with a certificate from your
keychain keeps the permission across rebuilds:

```bash
security find-identity -v -p codesigning
SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" scripts/install-blebridge.sh
```

Use the name the first command printed.

Remove the bridge with:

```bash
scripts/uninstall-blebridge.sh
```

## Try it without the studio

`scripts/mock-studio.mjs` runs the real CamBridge with three simulated Sony
bodies and lighting in dry run, on its own port (8089) with a temporary
config. Nothing it does can reach a real camera or light, and it runs beside
the real CamBridge without touching it. For simulated cameras, camd must be
built (`camd/build/camd`); without camd it runs with lighting only.

Start it so the phone can reach it on the network:

```bash
node scripts/mock-studio.mjs --lan --advertise
```

Then open `http://<the Mac's IP>:8089` in a browser on the Mac, go to
**Setup › Phones › Pair a phone**, and scan that code with the app. Stop the
simulator with Ctrl-C. Its config and pairings are thrown away.

To try Bluetooth with the simulator, quit the real CamBridge first (they would
share the one bridge), then run:

```bash
node scripts/mock-studio.mjs --lan --ble-socket "$HOME/Library/Application Support/CamBridge/blebridge.sock"
```

Turn off the phone's Wi-Fi to watch the app move to Bluetooth.

## Using it

The connection chip at the top right is always visible. It shows:
- **Wi-Fi · 12 ms** (green) or **Bluetooth · 84 ms** (blue): the link in use and its round trip;
- **Connecting…** (amber) or **Offline** (red): nothing is sent until CamBridge answers again;
- **… · 14s old**: the link is up, but no state has arrived for a while.

Tap the chip to see both links in words, or to ask for fresh state.

**Cameras.** At the top are the rolling count and **Record all** / **Stop all**.
Each camera card has:
- a tally edge (red for program, green for preview);
- **Record**, with the take's running time;
- battery and card time remaining;
- steppers for iris, ISO, shutter, ND and Kelvin. Tap a value to pick from the
  list. A value on Auto shows as Auto, with **Set Manual**;
- **Autofocus**, and **More controls** for white-balance mode, tint, AF mode and ND mode.

Turn on **Settings › Confirm before recording** to be asked before every
Record and Stop.

**Lighting.**
- **Output banner:** says when output is off, in dry run, or failing.
- **Looks:** the protected **Studio look** and **Studio off**.
- **Master faders:** level and colour for all lights, plus the 3200/4400/5600 K presets.
- **Scenes:**
  - tap to recall;
  - hold for 5 seconds to save, while a ring fills;
  - let go part-way and nothing happens.
- **Per-fixture faders:** level and colour for each light.

Looks, scenes and presets fade over the time set in **Settings** (1 s by
default). Faders move the lights directly.

**Settings** also holds:
- haptics;
- a manual CamBridge address, if Bonjour cannot find it;
- the app's permissions;
- **Pair again** and **Forget**.

## Security, and its limits

Both paths control live studio equipment, so:

- **Every Wi-Fi request is signed.** The phone sends
  `Authorization: CamBridge-HMAC id, ts, nonce, sig` over the method, the exact
  path and query, the time, a nonce and the body's hash. CamBridge refuses:
  - a bad signature, PIN or no PIN;
  - a time more than 2 minutes from its clock (the app learns the offset and
    retries once);
  - a reused nonce;
  - more than 30 failures a minute from one address.
- **Bluetooth needs pairing twice.**
  - The system bonding: the characteristics require an encrypted link.
  - The app key: a challenge and response in both directions, so a fake bridge
    is refused too.

  After that, every message is sealed with AES-256-GCM under per-session keys,
  with counters that only go up, so a replayed or reordered message is refused.
  A phone that fails gets a cooldown; a session that does not authenticate
  within 10 seconds is dropped, and the bridge then refuses that phone's writes.
- **Each phone has its own key, and can be revoked on its own.** There are no
  shared tokens.
- **No secrets in the repository.** Pairing keys live in CamBridge's git-ignored
  config (mode 0600) and the phone's Keystore. The signing key lives wherever you
  put it, outside the repository.

Limits, stated plainly:

- **Without a PIN, the Wi-Fi API stays open** to anything on the studio network
  that does not sign, as it was before the app (the studio chose not to use a
  PIN). The app still signs everything, and a revoked phone's app is refused.
  Over Bluetooth, only paired phones can do anything.
- **Over Wi-Fi, only the phone's requests are signed.** CamBridge's answers and
  the live state travel as plain HTTP on the studio network. Someone who can
  intercept that traffic could read the state or show the phone a false one,
  but cannot send a command as the phone. Over Bluetooth, both directions are
  sealed. HTTPS on the studio network would close this gap; it is not set up.
- **LE Secure Connections cannot be required** from either end through the APIs
  available (CoreBluetooth on the Mac, Android's GATT). The app's own
  authentication and encryption above do not depend on it.
- **The bridge cannot disconnect a phone.** macOS gives a Bluetooth peripheral no
  way to drop a central. When CamBridge refuses a phone, the bridge refuses
  its writes for 60 seconds instead.
- **blebridge has only been compiled and run on macOS with the user's own
  Swift toolchain**, not in this repository's automated tests. The tests drive
  CamBridge's gateway through a simulated bridge on the same socket.

## Troubleshooting

**"Bluetooth permission is needed" in the app.** The app was refused
**Nearby devices**. Allow it in the app's **Settings › Permissions**, or in
Android **Settings › Apps › CamBridge › Permissions**. Android only asks twice;
after that, the Android settings are the only way.

**"Not connected" on Wi-Fi with Android 17.** The app needs the **Local
network** permission to reach anything on the studio network, including
Bonjour. Allow it the same way.

**The app does not find CamBridge.**
1. Is the phone on the studio Wi-Fi, not mobile data or a guest network?
2. Is CamBridge listening on the network, not only on this Mac? The
   pairing code lists the addresses it gave. Check `cambridge.bind` in the
   config, or start it with `--lan` if it is the simulator.
3. Bonjour can be blocked by the network (client isolation, multicast
   filtering). Type the Mac's address in **Settings › CamBridge address**, for
   example `192.168.1.20:8088`.
4. On the Mac, check the advertisement: `dns-sd -B _cambridge._tcp`.

**"No longer knows this phone".** The phone was revoked in Setup › Phones, or
its pairing code expired (10 minutes) before the phone first connected. Pair
again with a new code. Only the CamBridge the phone was paired with can cause
this. A different CamBridge on the network (the simulator, a second studio)
does not.

**"This bridge belongs to a different CamBridge".** The bridge in range is
connected to another CamBridge, such as the simulator. Check which one is
running on the Mac.

**"The bridge is up, but CamBridge is not running on the Mac".** blebridge is
advertising, but CamBridge is not listening on its socket. Start CamBridge,
and check that the bridge's socket matches CamBridge's: see
[The Bluetooth bridge](#the-bluetooth-bridge).

**macOS keeps asking to allow Bluetooth for blebridge.** It is signed ad hoc,
which changes with every build. Sign it with a certificate: see
[The Bluetooth bridge](#the-bluetooth-bridge). `blebridge --check` says
whether it has the permission.

**"Bluetooth pairing with the Mac did not complete".** The first Bluetooth
connection needs the system pairing. Accept the prompt on both the phone and
the Mac. If it keeps failing, remove the Mac under Android **Settings ›
Connected devices** and the phone under **macOS System Settings › Bluetooth**,
then try again.

**"Too many failed attempts".** CamBridge saw 30 refused requests in a minute
from that address, such as a phone with a stale key. Wait a minute, and pair
again if the phone was revoked.

**A command shows a buzz and a message.** CamBridge refused it, and the
message is CamBridge's own reason, for example "scene 3 is empty" or a camera
error. Nothing changed.

## For developers

From `mobile/`:

```bash
./gradlew :core:test :app:testDebugUnitTest
./gradlew :app:testDebugUnitTest -Pcambridge.camd=../camd/build/camd
./gradlew :app:assembleDebug
```

The Motion tab's own tests run in `mobile/motion` (see
[motion.md](motion.md#tests)):

```bash
dart test
flutter test test_widget
flutter analyze
```

- `:core:test`:
  - checks the protocol code against the shared vectors;
  - checks the transport-switching policy on a virtual clock;
  - runs a full Bluetooth session against CamBridge's real gateway, through
    the simulated studio (needs Node).
- `:app:testDebugUnitTest` runs with Robolectric:
  - the Wi-Fi transport against a scripted server;
  - the Wi-Fi path end to end against the simulated studio. Give
    `-Pcambridge.camd` to include the simulated cameras;
  - hold-to-save;
  - confirm-before-record;
  - QR decoding of the code CamBridge draws;
  - rendering every screen. The pictures are in `app/build/screenshots`;
  - the Motion tab's side: the stops the app owns (background, close,
    Escape), the module's rig reports, and STOP ALL on every other screen.

On the server side, `npm test` in `cambridge/` includes:
- pairing and signatures;
- the Bluetooth codec and gateway;
- `npm run check:vectors`, which fails if the vectors file no longer matches
  what the server computes.

Regenerate the vectors with `node scripts/make-protocol-vectors.mjs` when the
protocol changes on purpose.

iOS is not built. Nothing above rules it out: the protocol, vectors and
server are platform-neutral. `mobile/core` is plain Kotlin and could
move to Kotlin Multiplatform, and the Bluetooth bridge is an ordinary GATT
peripheral.
