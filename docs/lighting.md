# Studio lighting

CamBridge drives the studio lights itself: the five Ikan Lyra LBX8-POE panels on
universe 1, over sACN (E1.31), from the lighting network port on the Mac (en14,
192.168.220.66). Companion stops talking to the lights directly. Its lighting
buttons talk to CamBridge, like its camera buttons do.

This page covers how it works, how to add a light or a new type of light, the
API, and the move from Companion's `generic-sacn` connection (labelled `SACN`)
with a way back.

## What runs where

```
 Lighting tab ─┐                 ┌─ Companion module (actions, presets)
 (browser)     │  /api/lighting  │
               ▼                 ▼
        cambridge server (Node) ── lighting service
                                     │  one state, in % and K
                                     ▼
                                   engine ── fades, 40 Hz while fading,
                                     │       re-send every 500 ms when idle
                                     ▼
                                   profiles ── % / K → DMX per fixture type
                                     ▼
                                   sACN sender ── UDP 5568 from 192.168.220.66
                                     ▼
                                   Lyra L1–L5 (unicast to each IP)
```

- **One state.** Each light's dimmer in percent and colour temperature in
  kelvin. Faders, Companion keys, scenes and looks all change this state.
  DMX is only ever produced from it, through each light's profile.
- **In the Node server, not camd.** Lighting is plain networking. camd and the
  Sony SDK have nothing to do with it, and lighting cannot block or crash the
  camera side. Every lighting fault (en14 down, a send failing, a bad config)
  becomes a status shown in the UI. None of them is an exception.
- **Live state** goes out on the same event stream as the cameras
  (`/api/events`), as a `lighting` field. A change-only patch carries it only
  when it changed.

Code: `cambridge/src/lighting/`.

| File | Role |
|---|---|
| `sacn.js` | Packet framing |
| `output.js` | The socket |
| `engine.js` | State and fades |
| `profiles.js` | Fixture types and conversion |
| `fixtures.js` | The patch and its validation |
| `looks.js` | The protected looks |
| `service.js` | Ties them together, persistence |
| `routes.js` | REST |
| `companion-import.js` | The one-time scene import |

The panel's tab is `cambridge/public/lighting.js`. The Companion side is
`companion-module-cambridge/src/lighting.js`.

## Safety rules, built in

| Rule | How |
|---|---|
| Never black out at startup | The last state is saved (0.5 s after it stops changing, and on quit) and restored on start, and sending resumes. With no saved state, **nothing at all** is sent until the first command. No frame of zeros is ever sent "to start with". |
| Output is off until someone turns it on | `lighting.output.enabled` defaults to `false`. A fresh install never fights Companion's sACN connection. |
| Dry run | Output on + dry run works out every frame and shows it (Lighting tab, `GET /api/lighting/frames`) but sends nothing. |
| Keep the lights fed | While idle the current state is re-sent every 500 ms (receivers time a source out after about 2.5 s). During a fade it is sent at 40 Hz, and any change goes out at once. |
| No guessing | A fixture with a problem (an overlap, a bad address, an unknown type) is **left out** of the output and flagged in red. It is not "fixed" behind your back. A patch change with a problem is refused and nothing is written. |
| One source | The UI and the Companion action warn before output is switched on: Companion's `SACN` connection must be off first. |

**When CamBridge stops sending** (output switched off, or the app quits), it
does not send an sACN "stream terminated" packet. It just stops. What the
Lyras then do (hold the last look, or go dark after their timeout) is not yet
known. See [the stale-DMX test](#the-stale-dmx-test).

## The lights

Seeded on first start (no `lighting` section in `cambridge.json`):

| Light | IP | Universe | Address | Type |
|---|---|---|---|---|
| L1 | 192.168.220.51 | 1 | 1–2 | Ikan Lyra LBX8-POE, 2-channel |
| L2 | 192.168.220.52 | 1 | 3–4 | 〃 |
| L3 | 192.168.220.53 | 1 | 5–6 | 〃 |
| L4 | 192.168.220.54 | 1 | 7–8 | 〃 |
| L5 | 192.168.220.55 | 1 | 9–10 | 〃 |

**To add, change or remove a light,** use the Lighting tab → **Fixtures**
(admin PIN). **Add fixture** suggests the next free address for the type you
pick. Saving checks the whole patch and shows any problem next to the field:

- two lights overlapping in a universe;
- an address or universe out of range;
- a duplicate name;
- an IP that cannot be a light's;
- an unknown type.

Nothing is saved until it is right. The light itself is never changed: set
its address and universe on the light to match.

**Groups** (comma-separated, e.g. `Key, Back`) give Companion and the API a
target between "one light" and "all".

## Fixture types (profiles)

A fixture type says what each of a light's DMX channels means. The built-in
Lyra profile is `cambridge/src/lighting/profiles/ikan-lyra-lbx8-poe-2ch.json`:

```json
{
  "id": "ikan-lyra-lbx8-poe-2ch",
  "name": "Ikan Lyra LBX8-POE — 2-channel",
  "channels": [
    { "type": "intensity", "label": "Dimmer" },
    { "type": "cct", "label": "CCT", "curve": [[0, 3200], [255, 5600]], "curveVerified": false }
  ]
}
```

**Channel types:**

- `intensity`: the dimmer, 0–100 % across `dmx` (default `[0, 255]`).
- `cct`: colour temperature. Its `curve` maps DMX values to kelvin as
  straight lines between points: any number of points, DMX rising, kelvin
  always going the same way.
- `fixed`: a channel that always sends `value` (a mode or effect channel that
  must sit at one value).

Any channel can be `"size": 2` for 16-bit (coarse then fine).

**A new type of light is data, not code.** Write its profile as JSON and paste
it into Lighting tab → **Fixture types** (admin). It is checked first, then
stored in `cambridge.json` under `lighting.profiles`. Then add the lights with
that type. A built-in profile cannot be edited; copy it under a new `id`
instead.

**The Lyra CCT curve is not measured.** It is assumed straight from 3200 K at
DMX 0 to 5600 K at DMX 255. The Studio look and Off are stored as DMX, so they
are unaffected. Kelvin readouts and kelvin presets depend on the curve. To
measure it:

1. Set a Lyra to DMX 0, 64, 128, 192 and 255 on the CCT channel in turn.
2. Read each one with a colour meter.
3. Put the points in a copy of the profile as `"curve": [[0, K0], [64, K64], …]`
   with `"curveVerified": true`.

## Scenes and the protected looks

- **Studio look**: `175 12 178 12 20 12 30 12 6 12` on channels 1–10, and
  **Studio off**: `0 12 0 12 0 12 0 12 0 12`. Both are built in, stored as
  exactly these DMX values, and cannot be saved over (they are not scene
  slots).
- **Scenes 1–5** (`lighting.sceneCount`, up to 99):
  - **Save** stores where every light is heading (the end of a fade, not a
    point halfway through it).
  - **Recall** fades every light in the scene over the fade time (1 s by
    default).
  - **Rename** and **Clear** work as expected.
  - Scenes are written to disk at once.
- **What's showing**: the look or scene the lights are showing is highlighted
  in the tab and lit on Companion keys. It is compared in DMX, so a scene
  recalled from kelvin still matches.

## Output settings

Lighting tab → **Output network settings** (admin). `cambridge.json` →
`lighting.output`:

| Key | Default | |
|---|---|---|
| `enabled` | `false` | Operator-level (Lighting tab, Companion). |
| `dryRun` | `false` | Operator-level. |
| `interface` | `en14` | Used to find the address if `address` is empty. |
| `address` | `192.168.220.66` | The Mac's address to send from. If this Mac does not have it (en14 unplugged), the tab says so and CamBridge retries every 5 s. |
| `mode` | `unicast` | `unicast`: each universe goes to the IPs of the lights in it. `multicast`: to 239.255.0.*universe*. |
| `priority` | `100` | sACN priority, 0–200. 100 is the usual default, and the same as Companion's `generic-sacn`. |
| `sourceName` | `CamBridge` | Shown by receivers and sACN tools. |

The sACN CID (the sender's identity) is made once and kept in
`cambridge-lighting.json`.

## Files

- `cambridge.json` → `lighting`:
  - `output`;
  - `fixtures` (the patch);
  - `profiles` (custom fixture types);
  - `sceneCount`;
  - `companionUrl` (default `http://127.0.0.1:8000`).

  It is written through the same atomic writer as the cameras (temp file,
  `.bak`, mode 0600). A hand-edited value that is wrong falls back to its
  default and is listed at the top of the Lighting tab. If `fixtures` is not a
  list, nothing is patched: CamBridge does not fall back to the built-in five.
- `cambridge-lighting.json`, beside it: the current state, the scenes and the
  CID. It is written atomically. Both files are git-ignored in `config/`.
- **Export / import** (Lighting tab, admin): the patch, custom fixture types
  and scenes as one JSON file. An import is checked and previewed first.

## API

JSON in and out, like the camera API. "Admin" needs the admin PIN or an admin
token once an admin PIN is set.

| Method and path | Who | Does |
|---|---|---|
| `GET /api/lighting` | operator | Everything: output status, lights (%, K, DMX, errors), groups, scenes, looks, what's showing, profiles |
| `GET /api/lighting/frames` | operator | The last frame per universe, sent or (in dry run) worked out |
| `POST /api/lighting/set` | operator | `{"target": {"all": true} \| {"group": "Key"} \| {"fixture": "L1"}, "intensity": 50, "cct": 4400, "relative": false, "fadeMs": 1000}`. A target is required. `relative` adds to where each light is heading. |
| `POST /api/lighting/looks/studio/recall`, `…/off/recall` | operator | `{"fadeMs": 1000}` |
| `POST /api/lighting/scenes/3/recall` | operator | `{"fadeMs": 1000}` |
| `PUT /api/lighting/scenes/3` | operator | Save where the lights are now; `{"name": "…"}` optional |
| `PATCH /api/lighting/scenes/3` | operator | Rename: `{"name": "…"}` |
| `DELETE /api/lighting/scenes/3` | operator | Clear |
| `POST /api/lighting/fixtures/l2/identify` | operator | Flash one light for `{"ms": 3000}`, then put it back |
| `PUT /api/lighting/output` | operator / admin | `enabled`, `dryRun` (operator); `interface`, `address`, `mode`, `priority`, `sourceName`, `port`, `cid` (admin) |
| `POST /api/lighting/fixtures`, `PUT` / `DELETE /api/lighting/fixtures/l6` | admin | The patch. A refusal is a 400 with `errors: [{fixture, field, message}]` and nothing written. |
| `GET` / `POST /api/lighting/profiles`, `PUT` / `DELETE /api/lighting/profiles/<id>` | admin | Custom fixture types |
| `GET /api/lighting/export`, `POST /api/lighting/import` | admin | `{"doc": …}` previews; add `"confirm": true` to write |
| `POST /api/lighting/import/companion` | admin | Reads Companion's scenes and previews; `{"confirm": true}` writes |

Every command is written to `cambridge.log` with who sent it. A fader drag is
logged as one line, when it settles.

## Companion

The module (1.1.0) has lighting actions, feedbacks, variables and ready-made
buttons for the old pages 5, 12 and 13. Scene keys work as before: tap to
recall, hold 5 s to save. The full list is in the module's help
(`companion-module-cambridge/companion/HELP.md`).

Installing or updating the module changes nothing on existing pages. The old
buttons keep driving the `SACN` connection until they are repointed (step 5
below).

## Cut-over from Companion's SACN connection

The rule throughout: **CamBridge and Companion's `SACN` connection never both
send universe 1.** Two sources at the same priority fight, and the lights
flicker between them. Nothing in Companion is deleted at any point. The old
connection is only disabled, so it can be enabled again.

### Facts this plan rests on

Checked against source:

- **Companion 5.0.2's HTTP API**
  ([`HttpApi.ts`](https://github.com/bitfocus/companion/blob/v5.0.2/companion/lib/Service/HttpApi.ts))
  has:
  - `GET /api/connections`;
  - `POST /api/connections/<id>/disable` and `…/enable`;
  - `GET /api/custom-variable/<name>/value`;
  - `POST /api/location/<page>/<row>/<column>/press`.

  All of them need **Settings → HTTP → HTTP API** switched on in Companion.
- **Companion's `generic-sacn` module**
  ([`main.ts`](https://github.com/bitfocus/companion-module-generic-sacn/blob/master/src/main.ts),
  v3.0.4):
  - **when disabled** it sends one packet marked "stream terminated", then
    stops. Receivers drop it at once instead of after 2.5 s;
  - **when enabled** it starts from **all 512 channels at 0** and its
    keep-alive sends those (every 800 ms idle, 40 ms during fades) until a
    button sets them. So **re-enabling it darkens the lights** until a
    Companion lighting key is pressed. The rollback below allows for this.
  - Its default priority is 100, the same as CamBridge's.

Not yet verified (each is a step below):

- what the Lyras do when their source stops;
- whether the Lyras accept **unicast** sACN, which is CamBridge's default
  (Companion's connection may be using multicast: check its **Target host IP**
  setting; 239.255.0.1 means multicast);
- the Lyra CCT curve.

### Before the day: nothing touches the lights

1. Update and restart CamBridge. Lighting output starts **off**.
2. Open the **Lighting** tab. It should show the five lights and no errors.
   It will also say *192.168.220.66 is not on this computer — is en14 up?* if
   en14 is down, which is harmless while output is off.
3. Install module 1.1.0 in Companion (`npm install` in
   `companion-module-cambridge`, then restart Companion). Existing pages are
   untouched.
4. Turn Companion's **HTTP API** on (Settings → HTTP) if it is off.
5. **Import the scenes.** Lighting tab → **Import & export** → **Read scenes
   from Companion…**. It reads `scene1`–`scene5` and `scene1_saved`–`scene5_saved`
   and shows a table: the values, what each light gets, and anything wrong.
   Check it against the scene keys on page 12, then **Import**. Companion is
   only read, never changed.
6. **Dry run.** Turn output on, with dry run on. Recall the Studio look, a
   scene or two, and use the faders. The DMX line under each light shows
   exactly what would be sent. Nothing leaves the Mac. Turn output off again.

### In the studio, watching the lights

Do these with someone looking at the panels. Each step says how to undo it.

**Step 1: find Companion's connection id.** This only reads; it changes
nothing:

```sh
curl -s http://127.0.0.1:8000/api/connections
```

Find the entry whose `label` is `SACN` and note its `id`. The commands below
use `SACN_ID` for it. Run this once in the same terminal, with your id in
place of the placeholder:

```sh
SACN_ID=<id>
```

**Step 2: the stale-DMX test.** This shows what the lights do when their source
goes away, which tells you how visible a swap or a CamBridge restart will be.
Press STUDIO LOOK on Companion so the lights are in a known state. Then disable
Companion's connection:

```sh
curl -s -X POST http://127.0.0.1:8000/api/connections/$SACN_ID/disable
```

Watch for 10 seconds. Record in the table below whether the panels held the
look or went dark, and when. Then put Companion back:

```sh
curl -s -X POST http://127.0.0.1:8000/api/connections/$SACN_ID/enable
```

**Then press STUDIO LOOK on Companion at once.** The re-enabled connection
starts from zeros (see above).

**Step 3: the swap.** Get the two sources to agree first, so the handover is
invisible:

1. Press STUDIO LOOK on Companion.
2. In CamBridge, with output still off, recall the Studio look (with fade
   **Snap**).
3. In the Lighting tab, make sure **dry run is off**.
4. Run the swap. One command line disables Companion's connection and turns
   CamBridge's output on straight after:

   ```sh
   curl -s -X POST http://127.0.0.1:8000/api/connections/$SACN_ID/disable && curl -s -X PUT http://127.0.0.1:8088/api/lighting/output -H 'Content-Type: application/json' -H "Authorization: Bearer $CB_TOKEN" -d '{"enabled": true, "dryRun": false}'
   ```

   `CB_TOKEN` is a CamBridge token (see
   [running-the-app.md](running-the-app.md#companion-scripts-and-anything-that-is-not-a-person)).
   If CamBridge has no PIN, the header is ignored. Instead of the second
   command you can press **Turn output on** in the Lighting tab straight after
   the first.
5. Check. The Lighting tab shows **Sending**, the packet count climbs, and the
   panels did not change.
6. Then move a fader. The matching panel should follow.

**If the panels do not follow,** they may not accept unicast. Roll back (below),
then set **Mode** to multicast in Output network settings and repeat this step.

**Step 4: Identify.** Press **Identify** on each light in turn: the right panel
should flash for 3 s, then return. This confirms the patch matches the room.

**Step 5: repoint the buttons.** One page at a time, put the module's
**Lighting — page 5 / 12 / 13** presets where the old keys were. Drag them in
over the old keys, or onto a copy of the page if you would rather keep the
old one to look at. Compare the old **LIGHTS ON** key's values with the new
preset's first: the new one sends every dimmer to 100 %, and the old key's
values were not visible when this was written. Old keys still pointing at the
disabled `SACN` connection do nothing, so a missed key is harmless.

### Rollback

From any point after the swap, in this order:

```sh
curl -s -X PUT http://127.0.0.1:8088/api/lighting/output -H 'Content-Type: application/json' -H "Authorization: Bearer $CB_TOKEN" -d '{"enabled": false}' && curl -s -X POST http://127.0.0.1:8000/api/connections/$SACN_ID/enable
```

**Then press STUDIO LOOK (or the scene you want) on Companion at once.** The
re-enabled connection starts from zeros. To make that automatic, add a press
of the old STUDIO LOOK key by its page, row and column to the same line, with
your key's position in place of the placeholders:

```sh
curl -s -X POST http://127.0.0.1:8000/api/location/<page>/<row>/<column>/press
```

The Lighting tab's **Turn output off** button does the same as the first
command. CamBridge keeps its patch, scenes and state, so the swap can be run
again later.

### The stale-DMX test

What the Lyras do when sACN stops. Fill this in during step 2. Also run it with
CamBridge as the source (turn its output off, watch, turn it back on), because
CamBridge stops without a "terminated" packet and Companion stops with one,
and receivers can treat the two differently.

| Source stops by | Lyras held the look? | Went dark after (s) | Date / who |
|---|---|---|---|
| Companion connection disabled (sends "terminated") | | | |
| CamBridge output off (just stops) | | | |
| CamBridge quit (just stops) | | | |

If they go dark, a CamBridge restart shows as a short blackout. CamBridge
resumes the last look as soon as it is back.

## Troubleshooting

| The Lighting tab says | Means |
|---|---|
| LIGHTS: NO NETWORK — *… is not on this computer — is en14 up?* | The Mac does not have the lighting address. Check the cable and en14's address (System Settings → Network). CamBridge retries every 5 s by itself. |
| LIGHTS: SEND ERRORS | Packets are failing to leave (switch, cable). Counted, logged once per burst, retried every frame. |
| LIGHTS: WAITING | Output is on, but nothing has been set since the state was cleared, so nothing is sent. Recall a look or scene. |
| LIGHTS: DRY RUN | Working everything out, sending nothing. |
| A light in red | Its patch entry has a problem and it is left out of the output. The message says what. |

`cambridge.log` has every lighting command, output change and fault, with who
did it.

## Not verified yet

- The Lyra CCT curve (assumed linear 3200–5600 K).
- Whether the Lyras accept unicast sACN, and whether they honour sACN
  priority.
- What the Lyras do when their source stops ([the table above](#the-stale-dmx-test)).
- What the old LIGHTS ON key sent.
- Real packets to the real panels. Everything so far is dry run, plus a
  loopback test that checks the packets on 127.0.0.1.
