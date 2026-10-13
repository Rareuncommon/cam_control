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
| Camera select | The first display buttons in reading order, one per PTZ camera, in config order |
| Presets | The display buttons that follow, starting on a new row (8 by default) |

**Camera buttons** show the camera's name. The LED colour shows tally: red on
program, green on preview. With no tally, the selected camera is amber and the
others white. The selected camera is also lit brighter. Switching cameras
stops whatever the stick was doing to the previous one.

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
