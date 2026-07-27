# Middle Control — what it does, and what CamBridge is missing

Research pass on the commercial product this project set out to replace, done to
find features worth taking rather than to copy the product. Sources at the end.

Everything below about the SDK has been checked against the real 2.02.00 headers
in `vendor/CrSDK/`, so the "how we would build it" notes are grounded rather than
speculative.

---

## What it is

A macOS application from Middle Things that unifies control of cameras, DJI
gimbals and PTZ heads. It is much broader than our problem: 150+ supported
devices across Sony, Blackmagic, Canon, Panasonic, Z-Cam, OBSBOT and BirdDog,
plus gimbal control, VISCA, and hardware control surfaces.

Licensing is freemium: the base app is free, **Middle Control 3 Pro is €199 as a
one-time purchase**, and there is a custom-priced Enterprise tier. Notably, Sony
camera control, live view, multiview and multi-operator are all **Pro** features.

Worth stating plainly: it is a mature product — five years of development,
claimed 10,000+ productions — and CamBridge is days old and has not been through
a shoot. The gap list below is what to build, not a claim that we have caught
up.

## How it appears to be built

Their architecture is not published, so this is inference from observable
behaviour, and flagged as such:

- **macOS-only, distributed outside the App Store.** Whether it is Swift/AppKit
  or a cross-platform shell is not documented anywhere I could find.
- **Almost certainly wraps the same Sony Camera Remote SDK we use.** The evidence
  is that its Sony requirements are identical to the ones we discovered
  independently: latest FX3/FX30 firmware, `USB-LAN/Tethering → USB-LAN
  Connection`, access authentication credentials on first connect, and
  specifically the RTL8153 and AX88179 USB-Ethernet chipsets. Those are SDK
  constraints, not application choices.
- **A TCP control API on port 11580**, with simple string commands (`CAM1`,
  `PRESET1C5`, `SPRESET1C5`). One-way command strings rather than a structured
  protocol. This is what the open-source Bitfocus Companion module talks to.
- **A built-in VISCA-over-IP server**, so hardware PTZ controllers can drive it.
- **ATEM Link**, translating Blackmagic's ATEM camera-control protocol into Sony
  commands so an ATEM panel drives Sony bodies.
- **SRT** for Blackmagic live view over LAN (3.2). Sony live view presumably
  comes from the SDK's own live view, as ours does.

The architectural difference that matters: Middle Control is one Mac app with a
TCP side-door. CamBridge is a daemon plus a web server, so the operator surface
is a browser — any laptop, iPad or phone on the VLAN, no install, no per-seat
licence.

---

## Feature comparison

### Already covered

| Middle Control | CamBridge |
|---|---|
| Iris, ISO, shutter, WB, tint | ✅ (tint pending confirmation on the FX30) |
| Focus, autofocus | ✅ absolute + relative nudge + AF trigger |
| Record start/stop, per camera and all | ✅ with read-before-write verification |
| Camera & gimbal presets | ✅ presets and scenes |
| "Replicate settings across multiple cameras" (Pro) | ✅ Match mode |
| "Synchronize parameters across cameras" (3.2) | ✅ Gang with per-camera offsets |
| Live View (Pro) | ✅ |
| Multi View, up to 9 cameras (Pro) | ✅ unlimited grid |
| Automatic camera discovery (3.2 Pro) | ✅ by MAC, with adoption UI |
| Multi-operator (Pro) | ✅ inherently — any number of browsers |

Two of those are worth noting. Automatic discovery arrived in Middle Control
**3.2, as a Pro feature**; ours does it by MAC with a full adoption flow.
Multi-operator is a licensed tier for them and free for us, because a web UI has
no seat concept.

### Missing, ranked for a live multi-camera shoot

**1. ND filter control.** The FX30 has an internal variable ND, and light
through windows changes across a shoot. This is the single most useful missing
control. SDK: `CrDeviceProperty_NDFilter`, `NDFilterModeSetting`,
`NDFilterValue`, `NDFilterOpticalDensityValue`. Straightforward — a mode switch
plus a value, same shape as the iris control we already have.

**2. Tap-to-focus on the live view.** Middle Control lets you tap the preview to
pull focus there. With multiview already built, this is mostly a click handler
that maps image coordinates to an AF area. SDK: `CrDeviceProperty_AFAreaPositionAF_C`
and `AFAreaPositionAF_S`, plus `CrDeviceProperty_FocusArea`. High value for a
single operator covering three cameras.

**3. Preset transition duration.** Theirs ramps a preset over a configurable
time rather than jumping. On air, an instant iris change is visible and ugly;
a two-second ramp is not. We already own the value tables, so this is
interpolation in the Node layer — no SDK work at all. Cheap and very visible.

**4. Selectable preset recall.** Their presets let you choose which parameters
are restored — iris only, or WB only, or everything. Ours captures a fixed set.
A small change to `control.js`, and it makes presets far more usable: "recall
the WB but leave my exposure alone."

**5. Monitoring assists.** Zebra, focus peaking, gamma display assist. SDK:
`CrDeviceProperty_ZebraDisplay` / `ZebraLevel`, `PeakingDisplay` / `PeakingLevel`
/ `PeakingColor`, `GammaDisplayAssist`. These affect the camera's own monitor
output, so they help whoever is at the camera more than the booth — worth having
but not urgent.

**6. Picture profile parameters.** Contrast, saturation, sharpness, black level.
Middle Control exposes these only when the picture profile is off, which matches
the SDK: `CrDeviceProperty_PictureProfile` plus `PictureProfile_BlackLevel`,
`_Gamma`, `_KneeMode` and friends. Useful for matching cameras beyond exposure
and WB — a genuine extension of our Match mode.

**7. Remote menu navigation.** Driving the camera's own menu from the booth.
The SDK has the full key set — `CrCommandId_RemoteKeyUp/Down/Left/Right/Set`,
`RemoteKeyMenuButton`, `RemoteKeyDisplayButton`. Combined with live view this
means never walking to a tripod mid-take. More work than it looks, because it
is only usable with the live view showing the menu.

**8. Subject tracking.** `CrDeviceProperty_SubjectRecognitionAF` and the
tracking sensitivity properties. Relevant for a moving speaker on the tight
camera.

**9. ATEM tally and Link.** Already in the project's own Phase 6 backlog. Tally
in the UI is the valuable half — knowing which camera is live before you change
its iris. `atem-connection` on the Node side, as originally planned.

**10. Bitfocus Companion.** Also already in the backlog. Their approach is a TCP
command server; ours would be simpler, since we already have a REST API a
Companion generic-HTTP module can drive today with no new code.

**11. Gamepad / joystick control.** They support DualSense over USB and assign
joysticks to camera IDs. The browser Gamepad API would give us this without any
native code, which is a neat consequence of being a web UI.

**12. VISCA over IP server.** Only worth it if you buy a hardware PTZ panel.

Not relevant to this build: gimbal control, PTZ heads, and the other camera
brands. Those are most of Middle Control's surface area and none of your problem.

---

## What CamBridge does that Middle Control does not

Worth being clear about, because it is the justification for the build:

- **Any device with a browser.** No install, no macOS requirement for the
  operator, no per-seat cost. The booth iPad, a laptop, a phone.
- **Sony control is not behind a licence.** It is their Pro tier.
- **The reliability model is explicit and tested.** Per-camera thread isolation,
  a documented 504 rather than a hang when a camera wedges, verified
  read-before-write record because the FX30 has no toggle command, and a test
  suite that proves one camera dropping does not affect the others. Whether
  Middle Control does any of this is unknowable from outside — but we can point
  at the tests.
- **Postmortem logging by design**, split into what the cameras did and what the
  operator asked for.
- **It is yours.** Extendable in a language you like, with no vendor roadmap
  between you and a feature you need.

---

## Suggested order of work

If the goal is closing the gap where it matters on a live shoot:

1. **ND filter** — biggest practical win, low effort
2. **Preset transition duration** — no SDK work, very visible on air
3. **Selectable preset recall** — small, makes presets genuinely usable
4. **Tap-to-focus in multiview** — high value, moderate effort
5. **ATEM tally** — knowing what is live before you touch it
6. Picture profile parameters, monitoring assists, remote menu, tracking

Items 2 and 3 are pure Node-layer work and could be done without touching the
daemon at all.

---

## Sources

- [Middle Control product page — Middle Things](https://www.middlethings.co/product-middle-control/)
- [Middle Control 3 Pro brings Sony camera control to Blackmagic ATEM switchers — CineD](https://www.cined.com/middle-control-3-pro-brings-sony-camera-control-to-blackmagic-atem-switchers/)
- [Middle Control 3.2 — Unified Control for your Favorite Cameras — Newsshooter](https://www.newsshooter.com/2026/04/14/middle-control-3-2-unified-control-for-your-favorite-cameras/)
- [Control Sony Cameras with Blackmagic Design ATEM Switchers — Newsshooter](https://www.newsshooter.com/2025/11/30/control-sony-cameras-with-blackmagic-design-atem-switchers/)
- [Sony Cameras setup — Middle Things docs](https://www.middlethings.co/support/docs/camera-control/sony-cameras/)
- [External SDK / API — Middle Things docs](https://www.middlethings.co/documentation/docs/Developers/tcp-api/)
- [companion-module-middlethings-middlecontrol — Bitfocus (GitHub)](https://github.com/bitfocus/companion-module-middlethings-middlecontrol)
- SDK property names verified against `vendor/CrSDK/include/CRSDK/CrDeviceProperty.h` and `CrCommandData.h` (Camera Remote SDK 2.02.00)
