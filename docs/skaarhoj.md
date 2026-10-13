# SKAARHOJ PTZ Extreme

CamBridge can work with a SKAARHOJ PTZ Extreme panel in two ways. An admin
chooses which one.

| Mode | Who moves the cameras | What CamBridge does |
|---|---|---|
| `reactor` (default) | The panel's own Reactor talks to the cameras directly | Polls each PTZ head, so moves, presets and settings made from the panel still show up in the browser |
| `drive` | CamBridge | Connects to the panel as its Raw Panel host. The joystick, buttons, encoders and displays all work through CamBridge, so every move and change is logged, undoable and visible to every surface |

Reactor mode needs no setup on the CamBridge side. Drive mode is opt-in and
needs a setting changed on the panel.

## Switching the panel between Reactor and CamBridge

**On the panel.** These steps come from SKAARHOJ's documentation (the Reactor
manual's "Remote Panels (RawPanel Mode)" page and the wiki page "Raw Panel Mode
or Using One Blue Pill Panel as the Main Unit"). They have not been checked on
a unit yet.

1. Open the PTZ Extreme's web UI and go to **System Manager → Settings →
   Raw Panel Mode**. The setting exists from System Manager 1.0.6 onwards.
2. Turn on **Enable**. Leave **Port** at 9923 unless something else needs it.
3. The panel then asks whether to also disable the Reactor package.
   SKAARHOJ recommends yes for a panel driven only from outside. Either way,
   the local Reactor loses the panel while Raw Panel Mode is on.
4. Allow TCP 9923 (or your port) through any firewall between the panel and
   CamBridge.

To hand the panel back to Reactor, turn Raw Panel Mode off. If you disabled the
Reactor package, start it again on the **Packages** page and switch its
autostart back on. SKAARHOJ's pages do not spell out the reverse procedure, so
treat these steps as unconfirmed.

**In CamBridge.** Do this as admin:

```sh
curl -X PUT http://<cambridge>:8088/api/skaarhoj \
  -H 'Content-Type: application/json' \
  -d '{"mode":"drive","host":"192.0.2.50","port":9923}'
```

The change takes effect at once, with no restart, and is saved to
`skaarhoj` in `config/cambridge.json`. `{"mode":"reactor"}` reverses it: CamBridge
stops any motion it was holding, clears the panel's displays and disconnects.
`GET /api/skaarhoj` returns the current mode, whether the panel is connected,
its model, serial and version, which camera it has selected, and how its
controls were mapped. The same block appears as `skaarhoj` in every state push.

### Not yet known

These questions are open. The answers need a real PTZ Extreme.

- **Can Reactor and CamBridge share the panel?** The protocol document says
  a panel in server mode can accept several clients. The Reactor manual's
  troubleshooting section says "only one connection at a time". Assume one
  driver at a time, and do not leave a remote Reactor pointed at the panel
  while CamBridge drives it.
- **Does the PTZ Extreme accept ASCII?** SKAARHOJ documents ASCII support for
  Blue Pill panels as a family, not for this model by name. CamBridge sends
  `list` first so an auto-detecting panel settles on ASCII. A panel that does
  not answer, or whose `_support=` list lacks `ASCII`, is refused with a
  message in `GET /api/skaarhoj` → `detail`, and retried slowly.
- Whether Raw Panel Mode survives a reboot of the panel. SKAARHOJ advises
  checking it after any restart.

## How the controls are mapped

SKAARHOJ does not document the PTZ Extreme's control numbers. CamBridge reads
the panel's own description of itself (its topology) and assigns roles from
it:

| Role | How it is found |
|---|---|
| Joystick pan / tilt | A horizontal and a vertical joystick axis that name each other as a pair. If no pair is named, the first horizontal axis and the vertical axis nearest it |
| Joystick twist | The rotary axis nearest the stick. It zooms only when the panel has no zoom rocker |
| Zoom | A control labelled "zoom", otherwise the unlabelled joystick-type axis left over after the stick (the rocker) |
| Focus | A control labelled "focus", otherwise an unlabelled rectangular encoder (the roller). Each roller pulse gives a short burst of focus speed |
| Encoders | Every other encoder, top to bottom and left to right. Each shows its setting on its own display, or on the nearest display-only control |
| STOP | Only a button labelled "stop", or one pinned in the mapping. It stops every PTZ camera |
| STORE, TRACKING | A button labelled "store"/"shift"/"save" or "track". Otherwise the next free display buttons after the presets |
| Camera select | The first display buttons in reading order, one per PTZ camera, in the operator's order, up to a cap (8 by default). More cameras than that are paged in banks, see below |
| Bank previous / next, Group | A button whose label says "prev", "next", "bank", "page", an arrow, or "group". Otherwise the last two camera buttons page (no group button) |
| Presets | The display buttons that follow, starting on a new row (8 by default) |

**Camera buttons** show the camera's name. The LED colour shows tally: red on
program, green on preview. With no tally, the selected camera is amber and the
others white. The selected camera is also lit brighter. Switching cameras
stops whatever the stick was doing to the previous one.

## Many cameras: banks and groups

The panel has a fixed number of buttons, so the camera buttons are capped and
the cameras are paged through them. `skaarhoj.mapping.cameraButtons` sets the
cap; the default is a third of the panel's display buttons, up to 8. On a
PTZ Extreme that is 8, which leaves the presets, STORE and TRACKING their
buttons however many cameras there are. Up to the cap, nothing changes: one
button per camera.

With more cameras than camera buttons:

- **Bank buttons.** A button labelled with "prev"/"previous", "next", "bank" or
  "page" (or an arrow such as ◀ ▶) is a bank button. A button that says only
  "bank" or "page", or has both arrows, goes to the next bank. Banks wrap
  round at both ends. You can pin them instead with `bankNext` and `bankPrev`
  in `skaarhoj.mapping`.
- **No bank buttons.** If none is labelled or pinned, the last two camera
  buttons become bank previous and next, so the cap includes them: 8 buttons
  give 6 cameras per bank. The cap must be at least 3 for this.
- **Display.** The bank buttons show "Bank 2/6". With the borrowed buttons, a
  single-bank view leaves them blank.
- **Tally across banks.** Each camera button keeps showing tally (red program,
  green preview) whether or not it is the selected camera. When a camera on
  program is on another bank, the bank button for that direction lights red and
  its second line says "PGM: <camera>". If the selected camera is on another
  bank, the bank buttons say "Sel: <camera>" instead.
- **Bank changes never move anything.** They change what the camera buttons
  show, not the selected camera, and whatever the stick is holding keeps going
  to the selected camera. Pressing a camera button on another bank selects it
  and stops the camera being left first, like any other selection.

Cameras appear in the operator's order from the browser, not alphabetically.

**Groups.** Cameras carry a group (the `group` field of each entry in `cameras` in the config).
Two optional controls use it:

- `skaarhoj.mapping.group` (a name, not case sensitive) restricts the panel to
  that one group. The camera buttons, banks and the default selected camera
  all come from that group. A name that matches nothing leaves the panel with
  no cameras, and the log says so.
- A button labelled "group" (or pinned as `groupButton`) cycles through *all
  cameras*, then each group in turn. It restarts at the first bank. It shows
  the group name, lights red if a camera on program is outside the groups
  being shown, and says "Sel: <camera>" if the selected camera is outside it.
  Selecting a camera in a group, or changing group, never moves a camera.
  The group button does nothing with fewer than two groups, or when `group`
  restricts the panel.

The number of camera buttons is worked out from the whole panel's cameras (or
the restricted group's), not the group being shown, so the layout does not
shuffle when a group is chosen. A group that fits on one bank just shows one
bank.

Not found by label? Pin them:

```json
"mapping": { "cameraButtons": 10, "bankPrev": 35, "bankNext": 36, "groupButton": 34 }
```

`GET /api/skaarhoj` reports `bank` (`index`, `count`, `size`, `cameras`) and
`group`, and `topologySummary` lists the bank and group buttons.

**Presets** recall on the selected camera. Hold STORE and press a preset to
store it. A preset stored this way gets a picture, like one stored from the
browser.

**Encoders** control the selected camera's Operate-card settings. Iris, gain,
shutter, ND and colour temperature come first, followed by the camera's other
`operate` settings. An encoder steps through a list one option per click, or a
range one step per click. Its display shows the setting's name and value.
Writes go through the same path as the browser's, so they appear in undo and
the log.

**Tracking** toggles auto-tracking, on cameras that have it.

**Motion safety.** The panel sends joystick values only when they change, and
`Speed:0` when the stick returns to centre. A joystick move therefore holds
until the panel says stop. If the connection drops, three heartbeats are
missed, the panel sleeps or reports `Blocked`, or the axis disappears from its
map, CamBridge stops every move the panel was holding. After a reconnect the
stick counts as centred until it moves again. The first 5% of stick travel
around centre is ignored.

### Overriding the mapping

If a role is guessed wrong, pin it in the config file under
`skaarhoj.mapping`, using the control ids shown in
`GET /api/skaarhoj` → `topologySummary`:

```json
"skaarhoj": {
  "mode": "drive", "host": "192.0.2.50", "port": 9923,
  "mapping": {
    "pan": 38, "tilt": 37, "rotate": 39, "zoom": 41, "focus": 42,
    "stop": 40, "store": 36, "tracking": 35,
    "cameras": [1, 2, 3, 4], "presets": [7, 8, 9, 10, 11, 12],
    "cameraButtons": 8, "bankPrev": 5, "bankNext": 6, "groupButton": 34, "group": "Stage",
    "encoders": [43, 44, 45, 46], "encoderDisplays": { "43": 52 },
    "presetCount": 8, "deadband": 0.05,
    "invertPan": false, "invertTilt": true, "invertZoom": false, "invertFocus": false
  }
}
```

Anything you pin is never guessed again. The remaining roles are still
guessed, but never take a control you have pinned. A `PUT /api/skaarhoj`
reloads the mapping from the file. CamBridge's direction conventions are pan
positive to the right, tilt positive up, zoom positive to tele and focus
positive to far. Use the `invert` flags if the panel's axes run the other way.

## What has been tested, and against what

All testing so far uses `cambridge/test/fakes/skaarhoj-panel.js`, a TCP server
that speaks the ASCII Raw Panel protocol as the spec notes describe it. Its
topology is invented, though it has the same kinds of controls as the PTZ
Extreme's datasheet. The tests in `cambridge/test/skaarhoj.test.js` cover:

- the handshake, ping/ack, and parsing of every event form
- refusal of a binary-only panel
- reconnecting, and detecting a hung panel
- role detection and mapping overrides
- camera select, tally and LED/text output
- banks and groups with 20 and 48 simulated cameras: paging and wrap-around, bank labels, tally on every bank, the program-on-another-bank signal, selection across banks stopping motion, borrowed, labelled and pinned bank buttons, group cycling and `mapping.group`
- joystick, rocker and roller motion
- stopping a deflected joystick when the panel disconnects or hangs
- encoders, presets, tracking and STOP
- switching mode through the API

To try it without hardware, run `node cambridge/test/fakes/skaarhoj-panel.js
--port 9923`, point CamBridge at `127.0.0.1`, and type event lines such as
`HWC#37=Speed:200` into the fake.

**Nothing has run against a real panel.** On a real PTZ Extreme, confirm:

- that ASCII mode is accepted and the reply to `list` arrives
- the control ids, labels and types in its topology, and whether the
  guesses above hold. In particular, whether the zoom rocker reports `Speed`
  or `Abs`, and whether the focus roller is drawn as a rectangle
- the joystick's sign conventions and centre noise (the deadband), and
  whether a release always ends in an exact `Speed:0`. A small batch of
  units shipped with the joystick rotated 90°; SKAARHOJ corrects it per
  serial number when the unit is online
- whether events and display commands use the topology's ids or the
  remapped ids from `map=`. They are the same on the fake
- how long titles and labels can be on its 64x32 and 112x32 displays
  (SKAARHOJ's document says 10 characters in one place and 24 in another)
- the multi-client and reboot questions above
- banks and groups, which have only been seen on the invented 36-button
  layout: whether the guessed camera/preset/bank rows look right on the real
  panel, that labels such as "Bank 2/6" and "PGM: <camera>" fit the 64x32
  displays, and that a button label the panel reports (an arrow, say) matches
  the bank-button wording
