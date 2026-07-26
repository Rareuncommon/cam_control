# Driving Sony's RemoteCli — Phase 0 acceptance

Sony's sample is a nested text menu with no help text, and the Ethernet path is
not the obvious one. This is the exact keypress sequence for our case, read out
of `RemoteCli.cpp` and `CameraDevice.cpp` in the 2.02.00 package.

Do this with **one FX30** only.

---

## Patch it first — it will not build or connect unmodified

Two problems, both confirmed on our own hardware. `scripts/patch-remotecli.sh`
fixes them; this section explains what it changes and why, so the edits are not
magic.

### 1. It does not compile on current Xcode

`RemoteCli.cpp:53`, inside an `#if defined(__APPLE__)` block:

```cpp
std::exit(EXIT_FAILURE);
return;                    // <- unreachable, and non-void main() must return a value
```

Dead code — `std::exit()` never returns — but AppleClang 21 promotes
`-Wreturn-mismatch` to a hard error, so the build fails with:

```
error: non-void function 'main' should return a value [-Wreturn-mismatch]
```

Only macOS builds reach it, which is why Sony has not caught it. The patch makes
it `return EXIT_FAILURE;`. `EXIT_FAILURE` is already in scope — it is used on the
preceding line.

### 2. The access-authentication username is hardcoded to `admin`

`CameraDevice.cpp:153`

```cpp
const char* inputId = "admin";
```

The sample prompts for a *password* but never a username — it always sends
`admin`, and there is no flag or environment variable to override it.

**Sony's cameras generate a random per-body username.** Ours is not `admin`, so
connection fails outright until this is corrected. Read the real value off
`MENU → Network → Network Option → Access Authen. Info` and pass it to the patch
script.

This matters beyond the sample: it means `camd` must carry a **per-camera
username** in config, not assume a constant. Already reflected in
`config/cambridge.example.json`.

### 3. Optional — the Ethernet model hint is hardcoded to the FX6

`RemoteCli.cpp:164`

```cpp
SDK::CrCameraDeviceModelList ethernetModel = ...CrCameraDeviceModel_ILME_FX6;
```

Passed to `CreateCameraObjectInfoEthernetConnection()`. We are on an FX30. The
enums are at `CRSDK/CrDefines.h:109-110` (`..._ILME_FX3`, `..._ILME_FX30`).

**Try the FX6 default first.** Whether that hint is enforced or merely advisory
tells us how `camd` should identify bodies in Phase 1, and that is worth one
failed connect attempt to learn. Add `--model FX30` only if it fails.

Note the MAC address is dummy data too (`CC:CC:CC:CC:CC:CC`, `RemoteCli.cpp:162`)
and the sample connects with it — so the SDK appears not to validate that field
for Ethernet connections, even though the camera displays a real MAC.

---

## Build

```sh
./scripts/patch-remotecli.sh --user <username-from-camera> ~/Downloads/RemoteCli
./scripts/build-remotecli.sh ~/Downloads/RemoteCli
cd build/remotecli && ./RemoteCli
```

The patch script is idempotent and saves `*.cambridge-orig` backups, so re-running
it or adding `--model FX30` later is safe.

## The sequence

| Prompt | Enter | Notes |
|---|---|---|
| `Please enter the IP address` | the camera's static IP | e.g. `10.0.0.51` |
| `Is it an SSH connection? (y/n)` | **`y`** | "SSH" is Sony's name for the access-authentication encrypted channel, not a separate transport. Answer `y` whenever `Access Authen. Settings` is On. |
| `Connect to camera with input number...` | **`1`** | only one camera is listed |
| `<< TOP-MENU >>` | **`1`** | Connect (Remote Control Mode) |
| `fingerprint: ...` `Are you sure you want to continue connecting? (y/n)` | **`y`** | the fingerprint is fetched from the camera over the wire; it should match the one on `Access Authen. Info` — **compare them**, that is the whole point of the field |
| `Please SSH password >` | the password from `Access Authen. Info` | masked with `*` as you type, so it will look like nothing is happening. The username is *not* prompted — it comes from the patch above. |
| `<< REMOTE-MENU >>` | **`1`** | Shutter/Rec Operation Menu |
| `<< Shutter/Rec Operation Menu >>` | **`7`** | **Movie Rec Button (Toggle)** — this is the acceptance test |

Press `7` again to stop recording. Option `6` is a non-toggling Movie Rec Button
if the toggle misbehaves.

**Confirm on the camera body, not in the CLI.** The tally / REC indicator on the
camera is the acceptance criterion — the CLI reporting success only proves the
command was accepted, not that the camera rolled.

To get out: `0` back to REMOTE-MENU, `0` to disconnect, `x` to exit.

## Worth poking at while you are connected

Not required to pass Phase 0, but each answer saves Phase 1 guesswork:

- **`3` Exposure/Color Menu** — can you read and set iris, ISO, shutter, WB?
  Note which properties the FX30 actually exposes and which are refused.
- **`4` Focus Menu** — does the lens report an absolute focus position, or only
  relative nudges? This decides whether presets can store focus on this lens.
- **`s` Status display** — what it reports for battery and media.

---

## What to send me

1. Whether it connected with the FX6 model hint, or needed `--model FX30`
2. Whether the fingerprint shown by the CLI matched the camera's screen
3. Any `Failed to connect: 0x...` code, verbatim — `CRSDK/CrError.h` decodes
   these precisely and the specific value narrows the cause a lot
4. Anything in the camera menus that did not match `docs/camera-setup.md`

**Not the password.** It goes in `config/cambridge.json`, which is git-ignored.
Sony's `Access Authen. Info` screen is regenerable — if a password has been
shown around, reinitialising network settings on the body rotates it.
