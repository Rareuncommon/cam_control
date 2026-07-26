# Sony Camera Remote SDK — placement

**Target machine:** Apple Silicon Mac, macOS 26 (Tahoe)
**SDK version:** 2.02.00

Do this once, on the control Mac. Nothing in this repo will build until it is done.

---

## Which of Sony's downloads you actually need

Sony's download splits into several archives. Only one of them is a build input:

| Archive | Needed? | What it is |
|---|---|---|
| **`RemoteCli.zip`** | **Yes — this is the SDK** | Headers (`app/CRSDK/`), the prebuilt libraries (`external/crsdk/`), the `RemoteCli` sample source, and prebuilt OpenCV. Everything we need. |
| `libssh2.zip` | No | Upstream OSS source, published for licence compliance. The prebuilt `libssh2.dylib` already ships inside `RemoteCli.zip`. |
| `libusb.zip` | No | Same — `libusb-1.0.0.dylib` already ships prebuilt. |
| `openssl.zip` | No | Same. OpenSSL is statically linked into Sony's `libssh2.dylib` (it loads nothing but `libSystem`), so there is nothing to build or install. |
| `Camera_Remote_SDK_Readme_v2.02.00.pdf` | Reference | Keep it. |

Archive the three OSS zips somewhere safe alongside the SDK for licence
compliance, but they are not part of the build. Do not commit them.

Also worth getting if you have not already: **`CrSDK_API_Reference_*.pdf`**.
Sony documents supported properties *per camera model*, and that document is the
authority on what we can actually control on the FX3 versus the FX30. Put it in
`docs/vendor/` (git-ignored) so we can both cite it.

## Confirmed by inspecting the shipped libraries

- **All dylibs are universal binaries (`x86_64` + `arm64`).** Native on Apple
  Silicon; no Rosetta, and the architecture question from the initial scaffold
  is settled.
- **Sony builds against macOS deployment target 12.1**, so `camd` matches it.
- **`camd` does not need OpenCV.** Only Sony's `RemoteCli` sample links it, for
  displaying live view in a desktop window. We relay JPEG frames instead.

---

## Placement

Unzip `RemoteCli.zip` somewhere scratch. Its structure is:

```
CMakeLists.txt
app/CRSDK/            <- headers
external/crsdk/       <- libCr_Core.dylib, libmonitor_protocol*.dylib, CrAdapter/
external/opencv/      <- only the sample needs this
```

Copy the two pieces we need into the repo:

```sh
cd /path/to/cam_control
UNPACKED=~/Downloads/RemoteCli          # wherever you unzipped it
mkdir -p vendor/CrSDK/include vendor/CrSDK/lib

# Headers — the whole CRSDK folder.
cp -R "$UNPACKED/app/CRSDK" vendor/CrSDK/include/

# Libraries — the entire contents of external/crsdk, including CrAdapter/.
cp -R "$UNPACKED/external/crsdk/." vendor/CrSDK/lib/

# Clear Gatekeeper quarantine, or macOS 26 will refuse to load the dylibs.
xattr -dr com.apple.quarantine vendor/CrSDK
```

Resulting layout:

```
vendor/CrSDK/
├── include/CRSDK/                  CameraRemote_SDK.h, CrDeviceProperty.h, ...
└── lib/
    ├── libCr_Core.dylib
    ├── libmonitor_protocol.dylib
    ├── libmonitor_protocol_pf.dylib
    └── CrAdapter/
        ├── libCr_PTP_IP.dylib      ← Ethernet control goes through this one
        ├── libCr_PTP_USB.dylib
        ├── libssh2.dylib
        └── libusb-1.0.0.dylib
```

Copy the *whole* `external/crsdk/` contents, not just `libCr_Core.dylib` —
`libmonitor_protocol.dylib` is referenced by name from the core library.

Also keep the unpacked `RemoteCli` tree around: Phase 0's acceptance test builds
Sony's sample from it.

---

## The one non-obvious runtime rule

`libCr_Core.dylib` loads its transport adapters from the relative path
**`Contents/Frameworks/CrAdapter`**, hardcoded inside the binary. Not
`./CrAdapter`. Put them in the wrong place and the SDK initialises perfectly,
reports success, and then enumerates zero cameras with no error worth reading.

You do not have to manage this: `crsdk_stage_runtime()` in
`camd/cmake/FindCrSDK.cmake` stages the libraries correctly next to every
binary we build, and Sony's own `RemoteCli` CMake does the same for the sample.
It is documented here because it is the single most likely cause of a
mysterious "connects to nothing" afternoon.

---

## Verify

```sh
./scripts/check-sdk.sh
```

Expected output is a list of green checks ending in `SDK layout OK`. It verifies
headers (all of them, not just the main one), `libCr_Core.dylib` and its arch,
the two `libmonitor_protocol` libraries, all four `CrAdapter` dylibs, and that
no quarantine attribute remains.

Then prove the toolchain links and loads:

```sh
cmake -S camd -B camd/build -DCMAKE_BUILD_TYPE=Debug
cmake --build camd/build --target camd-linkcheck
./camd/build/camd-linkcheck
```

`camd-linkcheck` initialises the SDK, prints the version it reports, and shuts
down. It touches no cameras, so it is safe to run at any time. Expected:

```
OK: Camera Remote SDK 2.02.00 (raw 0x02020000)
```

The API it calls (`SCRSDK::Init` / `GetSDKVersion` / `Release`) and the version
decode have been checked against the real 2.02.00 headers and against Sony's own
`RemoteCli.cpp`, so this should compile and run first time.

---

## Licence note

The SDK stays out of git permanently — `.gitignore` enforces it. If you move
this repo to another machine, repeat this document there rather than trying to
carry `vendor/CrSDK/` across in version control.
