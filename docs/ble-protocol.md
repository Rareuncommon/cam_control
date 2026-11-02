# CamBridge Bluetooth LE protocol, version 1

How the phone app talks to CamBridge over Bluetooth when it is near the Mac
but not on the studio network.

```
phone app ── BLE (GATT) ── blebridge (Swift, on the Mac) ── Unix socket ── cambridge (Node)
                                                                        src/ble/gateway.js
```

- **The bridge** (`blebridge/`) owns the radio. It advertises the service and
  carries bytes between each phone and the gateway. It understands none of
  the protocol and keeps no state beyond the connections.
- **The gateway** (`cambridge/src/ble/`) does everything else:
  - the handshake;
  - sealing;
  - requests;
  - live state;
  - limits.
- **Tests on both sides:** worked examples of every byte layout are in
  `protocol/vectors/v1.json`. The server's tests and the app's tests both check
  against that file, and `npm test` in `cambridge/` fails if it is stale.
  Regenerate it with:

  ```sh
  node scripts/make-protocol-vectors.mjs
  ```

## GATT

| | UUID | Properties | Security |
|---|---|---|---|
| Service | `8bc28765-0c3d-4e3a-b86e-7b066d7e4e4e` | advertised, with local name `CamBridge` | |
| INFO | `8bc28766-0c3d-4e3a-b86e-7b066d7e4e4e` | read | open: `{"v":1,"id":"<server id>","name":"<server name>"}` (UTF-8 JSON), so the app can match a bridge to its pairing before bonding |
| RX (phone → Mac) | `8bc28767-0c3d-4e3a-b86e-7b066d7e4e4e` | write with response | encrypted link required |
| TX (Mac → phone) | `8bc28768-0c3d-4e3a-b86e-7b066d7e4e4e` | notify | encrypted link required (subscribing triggers pairing) |

**The app's connection sequence:**

1. Scan for the service UUID.
2. Connect.
3. Request a 517-byte MTU.
4. Read INFO and check `id` against its pairing.
5. Subscribe to TX. This is when the system pairing (bonding) happens the first time.
6. Then the gateway sends HELLO.

## Chunks

Each RX write and each TX notification is one chunk.

| Byte | Meaning |
|---|---|
| 0 | bit 7 FIRST, bit 6 LAST, bits 0–5: the message counter mod 64 (per direction, +1 per message) |
| 1–3 (FIRST only) | total message length, big-endian (at most 262 144) |
| rest | message bytes |

**Chunk sizes:**

- **Phone writes:** at most ATT MTU − 3 bytes.
- **Gateway notifications:** at most the central's `maximumUpdateValueLength`, which the bridge reports.

**Reassembly:**

- A FIRST chunk starts a new message, abandoning any unfinished one.
- A chunk with the wrong counter, a missing FIRST, an overrun or a wrong final length is dropped. It is counted, never patched up.
- Nine bad chunks end a session.

## Messages

Byte 0 is the type. Before authentication only these four are allowed:

| Type | Direction | Layout |
|---|---|---|
| `0x01` HELLO | Mac → phone | `01` · version `01` · server nonce (16) · server id (UTF-8) |
| `0x02` AUTH | phone → Mac | `02` · version `01` · id length (1) · device id · client nonce (16) · proof (32) |
| `0x03` AUTH_OK | Mac → phone | `03` · server proof (32) |
| `0x04` AUTH_FAIL | Mac → phone | `04` · code (1) · reason (UTF-8) |

AUTH_FAIL codes:

| Code | Meaning |
|---|---|
| 1 | unknown device, or revoked |
| 2 | pairing code expired |
| 3 | the proof does not match |
| 4 | rate-limited |
| 5 | protocol error |
| 6 | no authentication within 10 s |

**Proofs and keys.** `K` is the device's 32-byte secret, from the pairing QR. HMAC is HMAC-SHA256.

- **The phone's proof:** `HMAC(K, "CamBridge BLE auth v1\0" ‖ serverNonce ‖ clientNonce ‖ deviceId ‖ serverId)`.
- **The server's proof:** `HMAC(K, "CamBridge BLE server v1\0" ‖ clientNonce ‖ serverNonce ‖ deviceId ‖ serverId)`.

  The phone checks this, so it knows it reached its own CamBridge.
- **Session keys:** `HKDF-SHA256(ikm = K, salt = serverNonce ‖ clientNonce, info = "CamBridge BLE session v1", 64 bytes)`.
  - bytes 0–31: phone → Mac;
  - bytes 32–63: Mac → phone.

**After AUTH_OK, every message is sealed:**

```
10 · counter (8, big-endian) · AES-256-GCM ciphertext · tag (16)
IV  = direction (4: 00000001 phone→Mac, 00000002 Mac→phone) · counter (8)
AAD = the 9 header bytes
```

- Counters start at 1 and must strictly increase.
- A replayed, reordered, altered or foreign message fails to open and is ignored.
- Three such failures end the session.

**Inside a sealed message:**

| Type | Direction | Layout |
|---|---|---|
| `0x20` REQUEST | phone → Mac | `20` · request id (4) · flags (1) · JSON `{"m": method, "p": path, "b": body?}` |
| `0x21` RESPONSE | Mac → phone | `21` · request id (4) · HTTP status (2) · flags (1) · JSON body (may be empty) |
| `0x30` STATE | Mac → phone | `30` · sequence (4) · flags (1) · JSON frame |
| `0x31` RESYNC | phone → Mac | `31` |
| `0x40` PING / `0x41` PONG | both | type · time (8) |
| `0x50` NOTICE | Mac → phone | `50` · JSON `{"code", "message"}`, e.g. `revoked` |

Flags bit 0 means the JSON is raw-DEFLATE compressed (RFC 1951). The sender
compresses when it saves space; a receiver must accept both.

## Requests

- **Same API as Wi-Fi.** A REQUEST is a CamBridge REST call (`GET /api/capabilities`, `POST /api/record-all`, …). The gateway runs it through the same router as Wi-Fi, as that paired phone (an operator), and returns the status and JSON body.
- **Not carried over Bluetooth:**
  - `/api/events`, because live state comes as STATE;
  - live view, which is Wi-Fi only (415);
  - non-JSON responses (415);
  - bodies over 64 KB.
- **Request ids and retries.** Request ids are chosen by the phone and stay unique per device for at least 2 minutes. A REQUEST that repeats an id gets the first answer again, without running a second time. So a command retried after a dropped link (even on a new session) is applied once.
- **Rate limit:** 40 requests in a burst, refilling at 20 a second, per device. Beyond that the answer is 429 and nothing runs.
- **Pending phones.** A phone whose QR has not been used yet may only send `POST /api/devices/activate` (`{"name", "model"}`). Its first STATE follows.

## State

- **The first frame.** After authentication, or after activation for a new phone, the gateway sends one STATE with a full frame (`"type": "state"`, the same shape as `GET /api/state`).
- **Deltas.** After that, each change is a STATE with a patch (`"type": "patch"`), exactly the event stream's patches. The app merges them with the same rules as `cambridge/public/patch.js`.
- **Slimming.** Fields the app does not use are removed from frames and patches:
  - camera addresses, host keys, SDK ids;
  - SKAARHOJ and undo state.
- **Sequence numbers** increase by one per STATE. A gap, or a patch naming a camera the phone does not have, means the phone sends RESYNC and gets a full frame.

## Limits and timeouts

| | |
|---|---|
| Authenticate after HELLO within | 10 s, or the connection is refused |
| AUTH attempts per connection | 3 |
| Failed AUTHs per device id | 5 a minute, then refused for a minute |
| A refused connection's writes | ignored by the bridge for 60 s (CoreBluetooth cannot disconnect a central) |
| Message size | 256 KiB |

## Security

**What it protects.** Nobody in Bluetooth range can control anything, read the
studio's state, or replay a phone's commands without that phone's pairing
secret:

- the secret never crosses the air: the phone proves it holds it;
- the server proves it back;
- every message after that is encrypted, authenticated and numbered under keys unique to the session.

**Bonding.** The data characteristics require an encrypted link, so a phone
must bond before it can subscribe. But neither CoreBluetooth (peripheral role)
nor Android lets an app insist on LE Secure Connections over legacy pairing.
That is decided by the two stacks, and modern ones choose Secure Connections.
The protocol is therefore built not to depend on it: link encryption is a
second layer, not the only one.

**Revocation.** Revoking a phone in Setup sends it a `revoked` NOTICE, closes
its session, and refuses it from then on.

**Logging.** The gateway logs connections, refusals and requests (as
`phone:<name>`) to `cambridge.log`.
