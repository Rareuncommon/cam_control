# Camera setup — FX3 / FX30 over wired Ethernet

Living document. Every setting we discover during bring-up gets recorded here,
so a future you (or a volunteer at 8am on a Sunday) can reconfigure a body from
scratch without guessing.

**Bodies:** 1× ILME-FX3, 2× ILME-FX30
**Transport:** USB-C → Gigabit Ethernet adapter (RTL8153 / AX88179), dedicated
production VLAN, static IPs.

Legend:
- ✅ **Verified from Sony documentation** — menu path confirmed against the official Help Guide.
- 🔍 **To confirm on hardware** — expected, but not yet seen with our own eyes. Update this file when we check it.

---

## 0. Firmware — do this first

USB-LAN is firmware-gated, so confirm versions before anything else.

| Feature | FX30 requirement | Why we care |
|---|---|---|
| Access authentication | Ver. 2.00 or later ✅ | Username/password on network connect. Required by the SDK. |
| Wired LAN (USB-LAN) | **Ver. 3.00 or later** ✅ | Without this the whole project is dead in the water. |
| `USB-LAN Cnct. Launch` | **Ver. 6.00 or later** ✅ | Auto-connects the LAN adapter at power-on. See §3 — this is the single most important setting for us. |

Check on each body: 🔍 `MENU → (Setup) → [Setup Option] → [Version]`

Record what you find:

| Body | Serial / label | Firmware | Checked on |
|---|---|---|---|
| FX3 | | | |
| FX30 #1 | | | |
| FX30 #2 | | | |

---

## 1. Physical connection

- USB-C → Gigabit Ethernet adapter into the camera's **USB Type-C** port.
- Sony explicitly recommends a **gigabit** adapter for USB-C, and warns that
  "not all types of USB-LAN conversion adaptors are guaranteed to operate
  properly." ✅ Our RTL8153 / AX88179 chipsets are the common, well-behaved ones.
- ⚠️ **Do not use the Multi/Micro USB terminal at the same time as USB Type-C.**
  Sony documents that using both terminals simultaneously blocks communication
  through *either* one, and can cause automatic connection to fail. ✅ If you
  ever hang a power or audio accessory off the Multi terminal, expect the
  network to die.

---

## 2. Static IP

✅ `MENU → (Network) → [Wired LAN] → [IP Address Setting] → [Manual]`

Then fill in:

| Field | Value |
|---|---|
| IP Address | (per body — see table below) |
| Subnet Mask | |
| Default Gateway | |
| Primary DNS Server | |
| Second DNS Server | |

Input constraints: digits and `.` only, 15 characters max per field. ✅ There is
no CIDR notation — enter a dotted subnet mask.

**Our address plan** (fill in during bring-up; these also go in `config/cambridge.json`):

| Body | IP | MAC | Notes |
|---|---|---|---|
| FX3 | | | |
| FX30 #1 | | | |
| FX30 #2 | | | |

---

## 3. Bring the LAN interface up

✅ `MENU → (Network) → [USB-LAN/Tethering] → [USB-LAN Connection]`
*(requires firmware Ver. 3.00 or later)*

Then — and this one is the difference between a system that survives a service
and one that does not:

✅ `MENU → (Network) → [USB-LAN/Tethering] → [USB-LAN Cnct. Launch] → [On]`
*(requires firmware Ver. 6.00 or later)*

> **Why this matters.** With `USB-LAN Cnct. Launch` set to `Off`, the camera
> does *not* bring up the Ethernet adapter automatically at power-on — someone
> has to walk to the camera and re-select `USB-LAN Connection` from the menu
> every single time the body is power-cycled. That makes the Phase 2
> power-cycle test unpassable by design, and it would mean a dead camera
> mid-service needs a human at the tripod rather than a reconnect from the
> booth. Set it to `On` on all three bodies and verify it survives a reboot.

To tear down deliberately: `[USB-LAN Disconnection]` under the same menu. ✅

---

## 4. Enable remote shooting

✅ `MENU → (Network) → [Cnct./Remote Sht.] → [Remote Shoot Function] → [Remote Shooting] → [On]`

🔍 There may be an additional connection-method or pairing selection under
`[Remote Shoot Function]` that matters for LAN (as opposed to USB / Wi-Fi
Direct) control. Confirm on hardware and document here.

---

## 5. Access authentication

Newer firmware authenticates the network connection, and the SDK must present
these credentials on connect.

- ✅ `MENU → (Network) → [Network Option] → [Access Authen. Settings]` — turn access
  authentication on. Encrypts the control channel. *(firmware Ver. 2.00+)*
- ✅ `MENU → (Network) → [Network Option] → [Access Authen. Info]` — displays the
  **username, password, MAC address, and fingerprint** for that body. *(firmware Ver. 2.00+)*

Read the credentials off each camera and put them in `config/cambridge.json`
(git-ignored — never commit them). Sony's own guidance is to treat this screen
as sensitive.

🔍 Open question for hardware bring-up: whether the password is stable across
power cycles and firmware updates, or regenerates. If it regenerates, our
config needs a re-pairing workflow rather than static credentials — flag it
immediately if you see it change.

| Body | Username | Password | Fingerprint |
|---|---|---|---|
| FX3 | | *(in config, not here)* | |
| FX30 #1 | | | |
| FX30 #2 | | | |

---

## 6. Power / sleep settings

🔍 A camera that sleeps drops its network connection, which will read to us as
a disconnect mid-service. Before the Phase 2 kill tests, find and disable auto
power-off — expected around `MENU → (Setup) → [Power Setting Option]`
(`Power Save Start Time`, `Auto Power OFF Temp.`). Document exact paths and the
values we settle on here once confirmed.

---

## 7. Per-body differences to keep in mind

- The **FX30 is Super 35 / APS-C**; the **FX3 is full-frame**. Base ISO and the
  usable ranges differ between them. `camd` reports raw SDK values verbatim;
  the `cambridge` Node layer is responsible for normalising these for display
  and for gang/match operations. Do not paper over the difference in the daemon.
- Confirm on hardware whether both models expose the same property IDs for
  iris/shutter/ISO/WB, or whether the FX3 reports any of them differently.
  Sony's per-model API reference PDF is the authority; record deviations here.

---

## Sources

- [ILME-FX30 Help Guide — USB-LAN/Tethering](https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1001273518.html)
- [ILME-FX30 Help Guide — Wired LAN (USB-LAN)](https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1000881000.html)
- [ILME-FX30 Help Guide — Remote Shoot Function](https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1000884035.html)
- [ILME-FX30 Help Guide — Access Authen. Info](https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1001106325.html)
- [ILME-FX30 Help Guide — Access Authen. Settings](https://helpguide.sony.net/ilc/2220/v1/en/contents/TP1001106326.html)
- [ILME-FX3 Help Guide — Wired LAN (USB-LAN)](https://helpguide.sony.net/ilc/2035/v1/en/contents/TP1000281183.html)
