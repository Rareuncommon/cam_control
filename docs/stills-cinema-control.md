# Stills and cinema camera control

CamBridge now has 416 USB driver profiles and 12 Blackmagic REST profiles, in
addition to its existing Sony SDK and PTZ support. The combined catalog has 508
entries. **Profiles include regional aliases and driver-mode variants; these
counts are not counts of independently validated physical camera models.**

USB entries are generated from installed libgphoto2 2.5.34 metadata, selecting
production-status still-camera USB drivers that advertise both image capture and
configuration. File-download-only and experimental drivers are excluded. The
actual connected body must expose a reliable serial and the requested writable
controls; inclusion in the upstream list alone does not establish that.

| Brand | New profiles | Examples |
| --- | ---: | --- |
| Canon | 209 | EOS R5, R5 C, R6, R7, R8, R50, EOS DSLR and PowerShot families |
| Nikon | 156 | Z8, Z9, Z6 III, Zf, Z-series and D-series bodies |
| Fujifilm | 18 | X-T5, X-H2, X-H2S, GFX families |
| Olympus | 22 | Supported upstream Olympus bodies |
| Leica | 5 | Supported upstream Leica bodies |
| Pentax | 2 | Production PTP profiles |
| Sigma | 2 | Supported upstream Sigma bodies |
| Panasonic | 2 | Supported upstream Panasonic bodies |
| Blackmagic Design | 12 | URSA Cine, PYXIS 6K, Cinema Camera 6K, URSA Broadcast G2 and Studio/Micro Studio families |

The complete list and provenance are in `cambridge/src/external/catalog.json`.
USB source: [libgphoto2 2.5.34](https://github.com/gphoto/libgphoto2/releases/tag/v2.5.34).
Blackmagic models and endpoint definitions come from its
[Camera REST API reference](https://documents.blackmagicdesign.com/DeveloperManuals/RESTAPIforBlackmagicCameras.pdf).
Neither the new USB bodies nor Blackmagic bodies have been tested on physical
hardware in this implementation run. Canon R5 C's USB driver entry does not
establish control in its cinema operating mode.

## USB setup

On this development Mac, gphoto2 2.5.32/libgphoto2 2.5.34 are installed and the
native helper is compiled. On another Mac, from this repository:

```sh
brew install gphoto2
node scripts/build-gphoto-control.mjs
```

Linux requires gphoto2, libgphoto2 development headers, a C compiler and pkg-config;
run the same helper build script after installing your distribution's packages.
Windows USB support is not claimed. The generated helper is ignored by Git and
links to the host's installed libgphoto2; it is not a portable binary. Existing
DMG packaging does not yet bundle these optional dependencies. To use USB with
an existing app bundle, install the dependencies/build the helper locally and
set CAMBRIDGE_GPHOTO_HELPER to its absolute path in the server environment.
Blackmagic REST has no gphoto dependency.

Enable the camera's tethering/PTP/PC Remote mode. Close other tethering software.
In Setup → Stills and cinema cameras, choose **Find USB cameras**, then Add.
Sony remains on the existing SDK path to avoid two adapters claiming the same
camera. Identical model names remain separate by USB port and verified serial.
If USB addresses change, remove and rediscover; CamBridge never guesses which
body to control by model name. Bodies without a reliable serial are refused.

The Control card exposes current writable ISO, aperture, shutter speed,
exposure compensation and white balance where the body reports them. Select a
value and Apply. The helper verifies the serial, reads fresh widget metadata,
validates the requested choice/value, and writes using one camera connection.
A second read verifies the result. No card formatting or deletion is exposed.

**Take photo to card** is available only when reported capture target is a memory
card and shutter state is known and non-Bulb. The helper repeats those checks
inside the capture connection. Choose the card target in the camera/tethering
setup before use. Photos remain on the camera; no download is performed. A
failed/timed-out capture is not retried automatically. Long exposures can outlast
the helper timeout; check the camera before another capture.
USB movie recording, autofocus, live view, video transfer and advanced vendor
features are not implemented by this adapter. Refresh USB controls explicitly;
background polling does not monopolize a USB tethering connection.

## Blackmagic setup

Enable Web Media Manager/network access in Blackmagic Camera Setup. Add the
camera's IPv4 address, port and HTTP/HTTPS setting in the same Setup section.
Use credentials if the camera's web manager requires them. HTTPS performs normal
certificate validation; self-signed certificates are not silently trusted.
The actual product response establishes the saved model. Credentials remain in
the private local configuration and are omitted from client state.

Recording Start/Stop and Record all include record-capable Blackmagic cameras.
ISO, gain, white balance, tint and shutter values appear only when their native
value and capability metadata endpoints respond. Unsupported lens/mode controls
are omitted. Changes are confirmed using camera readback; HTTP success alone
is insufficient. Stop can overtake read-only polling, cancels earlier queued
Starts, and serializes behind a Start already being transmitted. No blind
recording retries occur. Network faults can still leave the physical result
unknown. The five-second status poll refreshes recording; Refresh controls
reloads exposure metadata.

External cameras do not participate in Sony exposure matching, gangs, scenes,
undo, SDK live view, gamepad exposure controls, take logging, or unexpected-stop
tracking. Recording state and offline alarms are exposed, including `unknown`
after failed reads. Removing a connection or quitting does not stop recording.
Use Stop recording before removal if that is the intended outcome.

## API / Companion / Wordtandem

- `GET /api/external/catalog`: source-linked profiles.
- `GET /api/external/discovered`: non-Sony USB discovery (requires gphoto2).
- `POST /api/external/cameras`: admin adoption, verified before persistence.
- `DELETE /api/external/cameras/:id`: admin removal.
- `POST /api/external/cameras/:id/refresh`: read controls/state.
- `POST /api/external/cameras/:id/set`: `{ "key": "iso", "value": 800 }` for
  Blackmagic; USB uses the returned native key and choice index, or range value.
- `POST /api/external/cameras/:id/capture`: still photo to memory card.
- `POST /api/cameras/:id/actions/recordStart` / `recordStop`: Blackmagic recording.

State/SSE carries provider, capabilities and `external.controls`; values stay in
native units instead of being passed through Sony encodings. Companion adds
native-control, refresh and still-capture actions; its existing recording actions
work with Blackmagic. Wordtandem can consume these local interfaces later. Its
prompter code is unchanged.

## Verification and catalog maintenance

Run the application and Companion test suites. External tests cover protocol
responses, permissions, identity/choice guards, capture limits, readback,
persistence, concurrent Stop, stale/queued Start cancellation and unknown state.
Browser checks cover USB/cinema setup, controls, capture, recording, editing while
other camera cards update, and narrow-screen layout. The native helper harness
uses real libgphoto widget trees with mocked camera I/O; no physical device is
contacted. On this Homebrew Mac:

```sh
cc -D_GNU_SOURCE cambridge/test/gphoto-helper.test.c -I/opt/homebrew/include -L/opt/homebrew/lib -lgphoto2 -lgphoto2_port -lm -o /tmp/gphoto-helper-test
/tmp/gphoto-helper-test
```

To refresh upstream USB profiles, compile `scripts/list-gphoto-control-models.c`
against the installed libgphoto2 and capture its stdout to a file. It only reads
driver metadata, never opens cameras. Import that file using
`node scripts/import-gphoto-models.mjs FILE`, then run
`node scripts/sync-camera-catalog.mjs --write`. Review aliases and capability
filters rather than importing the much broader file-transfer-only device list.
