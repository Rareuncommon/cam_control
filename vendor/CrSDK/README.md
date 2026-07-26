# vendor/CrSDK — put the Sony Camera Remote SDK here

This directory is intentionally empty in git. The Sony Camera Remote SDK is
licensed per-developer, requires registration and license acceptance, and
**must not be committed to this repo**. `.gitignore` excludes everything here
except this file.

Full download and placement walkthrough: [`docs/sdk-install.md`](../../docs/sdk-install.md).

## Target layout

After unpacking, this directory must look like the following. The exact folder
names inside Sony's archive have changed between SDK releases, so copy the
*contents* into this shape rather than moving the archive folder here wholesale:

```
vendor/CrSDK/
├── include/
│   └── CRSDK/
│       ├── CameraRemote_SDK.h
│       ├── CrDeviceProperty.h
│       ├── CrCommandData.h
│       ├── CrDefines.h
│       ├── CrError.h
│       ├── CrTypes.h
│       ├── IDeviceCallback.h
│       └── ... (all other headers Sony ships)
└── lib/
    ├── libCr_Core.dylib
    └── CrAdapter/
        ├── libCr_PTP_IP.dylib
        ├── libCr_PTP_USB.dylib
        └── ... (everything else Sony ships in CrAdapter/)
```

## Two things that will bite you

1. **`CrAdapter/` must stay a subfolder next to the core library.** `libCr_Core.dylib`
   loads the transport adapters by relative path at runtime. If `CrAdapter/` is
   flattened or renamed, the SDK initialises fine and then finds zero cameras —
   with no useful error. Our CMake build copies `CrAdapter/` next to each built
   binary for this reason.

2. **macOS quarantines the dylibs.** They arrive unsigned from a downloaded
   archive, and on macOS 26 Gatekeeper will refuse to load them. Clear the
   quarantine attribute after unpacking:
   ```sh
   xattr -dr com.apple.quarantine vendor/CrSDK
   ```

## Verify placement

```sh
./scripts/check-sdk.sh
```

That script checks the headers and libs are where the build expects, confirms
the dylibs are `arm64`, and reports whether the quarantine attribute is still
set. Run it before the first build.
