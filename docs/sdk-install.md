# Sony Camera Remote SDK — download and placement

**Target machine:** Apple Silicon Mac, macOS 26 (Tahoe)
**SDK version to get:** 2.02.00 (released 10 June 2026) or newer

Do this once, on the control Mac. Nothing in this repo will build until it is done.

---

## 1. Register and download

The SDK is behind a registration + licence-acceptance wall, so it cannot be
fetched by script. Do it by hand in a browser:

1. Go to the **Camera Remote Toolkit** page:
   <https://support.d-imaging.sony.co.jp/app/sdk/en/index.html>
2. Follow through to the download (Sony routes you via a registration form on
   the regional pro site, e.g. <https://pro.sony/en_GB/digital-imaging/sdk-download>).
   You will need to supply an email address and accept the licence agreement:
   <https://support.d-imaging.sony.co.jp/app/sdk/licenseagreement_d/en-US.html>
3. Download the **macOS** package. It is named along the lines of
   `CrSDK_v2.02.00_<date>_Mac.zip`. Sony ships separate archives per platform
   (Win / Mac / Linux armv7 / armv8 / x64) — take only the Mac one.

> **On architecture:** Sony's page lists macOS 14.1+ / 15.1+ / 26.0+ but does
> not state Intel vs Apple Silicon on the public listing. Recent Mac packages
> have shipped arm64 slices. `scripts/check-sdk.sh` runs `lipo -info` on the
> dylibs and will tell you exactly what you got. If it reports `x86_64` only,
> stop and tell me — we would be running the daemon under Rosetta and I want
> to make that an explicit decision, not an accident.

Also worth grabbing while you are on that page:

- **The API reference PDF for your bodies.** Sony documents supported
  properties *per camera model*, and the FX3/FX30 support matrix is the
  authority on what we can actually control. Drop it in `docs/vendor/` (git
  ignores it) so we can both cite it.

---

## 2. Unpack and place

Unzip somewhere scratch, e.g. `~/Downloads/CrSDK_v2.02.00_Mac/`. Then copy the
pieces into this repo:

```sh
cd /path/to/cam_control
mkdir -p vendor/CrSDK/include vendor/CrSDK/lib

# Headers: the folder containing CameraRemote_SDK.h and friends.
# In Sony's archive this is usually app/CRSDK/ or include/CRSDK/.
cp -R ~/Downloads/CrSDK_v2.02.00_Mac/app/CRSDK vendor/CrSDK/include/

# Libraries: libCr_Core.dylib plus the whole CrAdapter/ folder, unflattened.
cp ~/Downloads/CrSDK_v2.02.00_Mac/**/libCr_Core.dylib vendor/CrSDK/lib/
cp -R ~/Downloads/CrSDK_v2.02.00_Mac/**/CrAdapter vendor/CrSDK/lib/

# Clear Gatekeeper quarantine or the dylibs will refuse to load on macOS 26.
xattr -dr com.apple.quarantine vendor/CrSDK
```

The `**` globs assume `shopt -s globstar` (bash) or zsh, which is macOS's
default shell. If the paths do not match, just find `CameraRemote_SDK.h` and
`libCr_Core.dylib` in the unpacked tree and copy by hand — the target layout is
what matters, and it is written out in
[`vendor/CrSDK/README.md`](../vendor/CrSDK/README.md).

**Also keep Sony's unpacked archive.** Phase 0 builds Sony's own `RemoteCli`
sample from it. Put it at `vendor/RemoteCli/` (git ignored) or leave it in
Downloads and pass the path to the build script.

---

## 3. Verify

```sh
./scripts/check-sdk.sh
```

Expected output is a list of green checks ending in `SDK layout OK`. It
verifies:

- `CameraRemote_SDK.h` is reachable at `vendor/CrSDK/include/CRSDK/`
- `libCr_Core.dylib` exists and is arm64
- `CrAdapter/` exists as a *subdirectory* of `lib/` and is non-empty
- no `com.apple.quarantine` attribute remains

Then prove the toolchain links against it:

```sh
cmake -S camd -B camd/build -DCMAKE_BUILD_TYPE=Debug
cmake --build camd/build --target camd-linkcheck
./camd/build/camd-linkcheck
```

`camd-linkcheck` does nothing but initialise the SDK, print the version it
reports, and shut down. It touches no cameras. If it prints a version number,
headers + libs + rpath + `CrAdapter/` are all correct and we are clear to
build real code against it.

If it fails to *compile* with unknown-symbol errors, the API surface moved in
2.x versus the 1.x-era names this scaffold assumes — send me the compiler
output and I will adjust. That is a five-minute fix, and finding it now is
precisely the point of Phase 0.

---

## 4. Licence note

The SDK stays out of git permanently. `.gitignore` enforces it. If you ever
move this repo to another machine, repeat this document there — do not try to
copy `vendor/CrSDK/` between machines via git.

---

## Sources

- [Camera Remote SDK — Camera Remote Toolkit (Sony)](https://support.d-imaging.sony.co.jp/app/sdk/en/index.html)
- [Download Camera Remote SDK (Sony Pro)](https://pro.sony/en_GB/digital-imaging/sdk-download)
- [Camera Remote SDK licence agreement](https://support.d-imaging.sony.co.jp/app/sdk/licenseagreement_d/en-US.html)
