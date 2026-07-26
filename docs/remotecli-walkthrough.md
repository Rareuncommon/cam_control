# Driving Sony's RemoteCli — Phase 0 acceptance

Sony's sample is a nested text menu with no help text, and the Ethernet path is
not the obvious one. This is the exact keypress sequence for our case, read out
of `RemoteCli.cpp` and `CameraDevice.cpp` in the 2.02.00 package.

Do this with **one FX30** only.

---

## Two hardcoded values that will stop you

Read these before you start, because both fail in ways that look like a network
or camera problem.

### 1. The username is hardcoded to `admin`

`CameraDevice.cpp:153`

```cpp
const char* inputId = "admin";
```

The sample prompts for a *password* but never for a username — it always sends
`admin`. Check the username on the camera's `Access Authen. Info` screen. If it
is not `admin`, the sample cannot connect until that line is edited.

**Report the username to me** either way; it determines whether `camd` needs it
as config or can assume a constant.

### 2. The Ethernet model is hardcoded to the FX6

`RemoteCli.cpp:164`

```cpp
SDK::CrCameraDeviceModelList ethernetModel = SDK::CrCameraDeviceModelList::CrCameraDeviceModel_ILME_FX6;
```

That model hint is passed to `CreateCameraObjectInfoEthernetConnection()`. We are
connecting to an FX30, not an FX6. If the connect fails, **this is the first
thing to change** — the enum values exist in `CRSDK/CrDefines.h:109-110`:

```cpp
CrCameraDeviceModel_ILME_FX3,
CrCameraDeviceModel_ILME_FX30,
```

So edit line 164 to `CrCameraDeviceModel_ILME_FX30` and rebuild
(`./scripts/build-remotecli.sh ~/Downloads/RemoteCli`).

Try it unedited first — it is useful to know whether the hint is enforced or
merely advisory, because that shapes how `camd` identifies bodies in Phase 1.

Incidentally the MAC address is dummy data too (`CC:CC:CC:CC:CC:CC`,
`RemoteCli.cpp:162`) and the sample connects with it, which suggests the SDK does
not validate that field for Ethernet connections.

---

## The sequence

```
./scripts/build-remotecli.sh ~/Downloads/RemoteCli
cd build/remotecli && ./RemoteCli
```

| Prompt | Enter | Notes |
|---|---|---|
| `Please enter the IP address` | the camera's static IP | e.g. `10.0.0.51` |
| `Is it an SSH connection? (y/n)` | **`y`** | "SSH" is Sony's name for the access-authentication encrypted channel. Answer `y` whenever `Access Authen. Settings` is On. |
| `Connect to camera with input number...` | **`1`** | only one camera is listed |
| `<< TOP-MENU >>` | **`1`** | Connect (Remote Control Mode) |
| `fingerprint: ...` `Are you sure you want to continue connecting? (y/n)` | **`y`** | the fingerprint is fetched from the camera; it should match `Access Authen. Info` on the body — **check that it does** |
| `Please SSH password >` | the password from `Access Authen. Info` | masked with `*` as you type, so it will look like nothing is happening |
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

1. Whether it connected unedited, or needed the `ethernetModel` change
2. The **username** from `Access Authen. Info` (is it `admin`?)
3. Whether the fingerprint shown by the CLI matched the camera's screen
4. Any `Failed to connect: 0x...` code, verbatim — `CRSDK/CrError.h` decodes
   these precisely and the specific value tells us a lot
5. Anything in the camera menus that did not match `docs/camera-setup.md`

Do not send me the password.
