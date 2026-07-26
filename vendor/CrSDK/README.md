# vendor/CrSDK — put the Sony Camera Remote SDK here

This directory is intentionally empty in git. The Sony Camera Remote SDK is
licensed per-developer, requires registration and licence acceptance, and
**must not be committed to this repo**. `.gitignore` excludes everything here
except this file.

Full walkthrough: [`docs/sdk-install.md`](../../docs/sdk-install.md).

## Where it comes from

Everything needed is inside Sony's **`RemoteCli.zip`** (SDK 2.02.00) — headers
under `app/CRSDK/`, prebuilt libraries under `external/crsdk/`. The separate
`libssh2.zip`, `libusb.zip` and `openssl.zip` downloads are upstream OSS source
published for licence compliance; they are not build inputs.

## Target layout

```
vendor/CrSDK/
├── include/CRSDK/                  <- copy of app/CRSDK/
│   ├── CameraRemote_SDK.h
│   ├── CrDeviceProperty.h
│   ├── CrCommandData.h
│   ├── CrError.h
│   ├── IDeviceCallback.h
│   ├── ICrCameraObjectInfo.h
│   └── ... (all other headers Sony ships)
└── lib/                            <- copy of external/crsdk/
    ├── libCr_Core.dylib
    ├── libmonitor_protocol.dylib
    ├── libmonitor_protocol_pf.dylib
    └── CrAdapter/
        ├── libCr_PTP_IP.dylib
        ├── libCr_PTP_USB.dylib
        ├── libssh2.dylib
        └── libusb-1.0.0.dylib
```

## Three things that will bite you

1. **Copy the whole of `external/crsdk/`, not just `libCr_Core.dylib`.**
   `libmonitor_protocol.dylib` is referenced by name from the core library.

2. **`CrAdapter/` is loaded from `Contents/Frameworks/CrAdapter` at runtime** —
   that relative path is hardcoded inside `libCr_Core.dylib`. In *this* vendor
   tree it just sits under `lib/`; the build stages it to the right place next
   to each binary via `crsdk_stage_runtime()`. If the adapters are ever in the
   wrong place, the SDK initialises successfully and then finds zero cameras
   with no useful error.

3. **macOS quarantines the dylibs.** They arrive unsigned from a downloaded
   archive, and Gatekeeper on macOS 26 will refuse to load them:
   ```sh
   xattr -dr com.apple.quarantine vendor/CrSDK
   ```

## Verify placement

```sh
./scripts/check-sdk.sh
```

Checks every header, both `libmonitor_protocol` libraries, all four `CrAdapter`
dylibs, the architecture (`arm64` expected — Sony ships universal binaries), and
the quarantine attribute. Run it before the first build.
