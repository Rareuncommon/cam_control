// E1.31 (sACN) data packets: building them, and reading them back.
//
// Written out here rather than taken from npm: the layout is fixed by ANSI
// E1.31-2018 and fits on one screen, this server has no runtime dependencies,
// and the one maintained package (`sacn`) binds its interface option to
// multicast only — unicast to the lights from en14 needs the socket bound to
// en14's address, which the sender in output.js does itself.
//
// Byte layout of a data packet with a full universe (638 bytes). Every offset and
// fixed value below was checked against two independent implementations:
// libe131 (hhromic/libe131, e131.h/e131.c) and sACN (k-yle/sACN, packet.ts).
//
//   Root layer      0  preamble size 0x0010        2  post-amble size 0x0000
//                   4  ACN packet identifier "ASC-E1.17\0\0\0" (12)
//                  16  flags+length (0x7000 | bytes from here to the end)
//                  18  vector 0x00000004 (VECTOR_ROOT_E131_DATA)
//                  22  CID (16)
//   Framing layer  38  flags+length              40  vector 0x00000002
//                  44  source name, UTF-8, NUL-padded (64)
//                 108  priority (0–200)         109  sync address (0 = none)
//                 111  sequence number          112  options
//                 113  universe (1–63999)
//   DMP layer     115  flags+length             117  vector 0x02
//                 118  address & data type 0xa1 119  first property address 0
//                 121  address increment 1      123  property value count (1 + slots)
//                 125  START code 0x00          126  DMX slots (up to 512)

export const SACN_PORT = 5568;
export const MAX_SLOTS = 512;
export const DEFAULT_PRIORITY = 100;
export const MAX_PRIORITY = 200;
export const MIN_UNIVERSE = 1;
export const MAX_UNIVERSE = 63999;
/**
 * How long a receiver may wait before dropping a source that went quiet.
 * 2.5 s is what OLA's receiver uses ("expire sources after 2.5s",
 * DMPE131Inflator); the idle refresh is kept well inside it.
 */
export const NETWORK_DATA_LOSS_TIMEOUT_MS = 2500;

export const OPTION_PREVIEW_DATA = 0x80;
export const OPTION_STREAM_TERMINATED = 0x40;
export const OPTION_FORCE_SYNCHRONIZATION = 0x20;

const ACN_PACKET_IDENTIFIER = Buffer.from([0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]);
const VECTOR_ROOT_E131_DATA = 0x00000004;
const VECTOR_E131_DATA_PACKET = 0x00000002;
const VECTOR_DMP_SET_PROPERTY = 0x02;
const DMP_ADDRESS_DATA_TYPE = 0xa1;

const HEADER_BYTES = 126;
const ROOT_FLAGS_AT = 16;
const FRAMING_FLAGS_AT = 38;
const DMP_FLAGS_AT = 115;
const SOURCE_NAME_BYTES = 64;

/** The multicast group a universe is sent to: 239.255.<high byte>.<low byte>. */
export function multicastAddress(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/** A CID is a 16-byte UUID; this makes one as a canonical string. */
export function newCid() {
  return crypto.randomUUID();
}

/** "0f5c…-…" -> 16 bytes. Throws on anything that is not a UUID. */
export function cidBytes(cid) {
  const hex = String(cid ?? '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`not a CID (UUID): ${cid}`);
  return Buffer.from(hex, 'hex');
}

/**
 * One E1.31 data packet.
 *
 * @param {object} o
 * @param {string} o.cid          UUID string
 * @param {string} o.sourceName   shown by receivers that display sources
 * @param {number} o.priority     0–200
 * @param {number} o.sequence     0–255
 * @param {number} o.universe     1–63999
 * @param {Uint8Array|number[]} o.slots  DMX values, slot 1 first; up to 512
 * @param {number} [o.options=0]
 * @returns {Buffer}
 */
export function buildDataPacket({ cid, sourceName, priority = DEFAULT_PRIORITY, sequence, universe, slots, options = 0 }) {
  if (!Number.isInteger(universe) || universe < MIN_UNIVERSE || universe > MAX_UNIVERSE) {
    throw new RangeError(`universe ${universe} is outside ${MIN_UNIVERSE}–${MAX_UNIVERSE}`);
  }
  if (!Number.isInteger(priority) || priority < 0 || priority > MAX_PRIORITY) {
    throw new RangeError(`priority ${priority} is outside 0–${MAX_PRIORITY}`);
  }
  const count = slots?.length ?? 0;
  if (count < 1 || count > MAX_SLOTS) throw new RangeError(`slot count ${count} is outside 1–${MAX_SLOTS}`);

  const length = HEADER_BYTES + count;
  const b = Buffer.alloc(length);
  // Root layer.
  b.writeUInt16BE(0x0010, 0);
  b.writeUInt16BE(0x0000, 2);
  ACN_PACKET_IDENTIFIER.copy(b, 4);
  b.writeUInt16BE(0x7000 | (length - ROOT_FLAGS_AT), ROOT_FLAGS_AT);
  b.writeUInt32BE(VECTOR_ROOT_E131_DATA, 18);
  cidBytes(cid).copy(b, 22);
  // Framing layer.
  b.writeUInt16BE(0x7000 | (length - FRAMING_FLAGS_AT), FRAMING_FLAGS_AT);
  b.writeUInt32BE(VECTOR_E131_DATA_PACKET, 40);
  writeSourceName(b, 44, sourceName);
  b.writeUInt8(priority, 108);
  b.writeUInt16BE(0, 109);
  b.writeUInt8(sequence & 0xff, 111);
  b.writeUInt8(options & 0xff, 112);
  b.writeUInt16BE(universe, 113);
  // DMP layer.
  b.writeUInt16BE(0x7000 | (length - DMP_FLAGS_AT), DMP_FLAGS_AT);
  b.writeUInt8(VECTOR_DMP_SET_PROPERTY, 117);
  b.writeUInt8(DMP_ADDRESS_DATA_TYPE, 118);
  b.writeUInt16BE(0x0000, 119);
  b.writeUInt16BE(0x0001, 121);
  b.writeUInt16BE(count + 1, 123);
  b.writeUInt8(0x00, 125);
  for (let i = 0; i < count; i++) b[HEADER_BYTES + i] = slots[i] & 0xff;
  return b;
}

/** Truncated to 63 bytes on a character boundary, so the field always ends in NUL. */
function writeSourceName(b, at, name) {
  let bytes = Buffer.from(String(name ?? ''), 'utf8');
  if (bytes.length > SOURCE_NAME_BYTES - 1) {
    let cut = SOURCE_NAME_BYTES - 1;
    while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--;   // never split a UTF-8 sequence
    bytes = bytes.subarray(0, cut);
  }
  bytes.copy(b, at);
}

/**
 * Reads a data packet back. For the loopback tests and for diagnostics; it
 * checks every fixed field and throws on the first that is wrong, so a test
 * failure names the field.
 */
export function parseDataPacket(b) {
  const fail = (what) => { throw new Error(`not an E1.31 data packet: ${what}`); };
  if (!Buffer.isBuffer(b) || b.length < HEADER_BYTES + 1) fail(`length ${b?.length}`);
  if (b.readUInt16BE(0) !== 0x0010) fail('preamble size');
  if (b.readUInt16BE(2) !== 0x0000) fail('post-amble size');
  if (!b.subarray(4, 16).equals(ACN_PACKET_IDENTIFIER)) fail('ACN packet identifier');
  const layer = (at) => {
    const v = b.readUInt16BE(at);
    if ((v & 0xf000) !== 0x7000) fail(`flags at ${at}`);
    if ((v & 0x0fff) !== b.length - at) fail(`length at ${at}: ${v & 0x0fff}, expected ${b.length - at}`);
  };
  layer(ROOT_FLAGS_AT);
  if (b.readUInt32BE(18) !== VECTOR_ROOT_E131_DATA) fail('root vector');
  layer(FRAMING_FLAGS_AT);
  if (b.readUInt32BE(40) !== VECTOR_E131_DATA_PACKET) fail('framing vector');
  layer(DMP_FLAGS_AT);
  if (b.readUInt8(117) !== VECTOR_DMP_SET_PROPERTY) fail('DMP vector');
  if (b.readUInt8(118) !== DMP_ADDRESS_DATA_TYPE) fail('address and data type');
  if (b.readUInt16BE(119) !== 0) fail('first property address');
  if (b.readUInt16BE(121) !== 1) fail('address increment');
  const count = b.readUInt16BE(123);
  if (count !== b.length - 125) fail(`property value count ${count}`);
  const nameField = b.subarray(44, 108);
  const nul = nameField.indexOf(0);
  return {
    cid: [...b.subarray(22, 38)].map((x) => x.toString(16).padStart(2, '0')).join('')
      .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'),
    sourceName: nameField.subarray(0, nul < 0 ? 64 : nul).toString('utf8'),
    priority: b.readUInt8(108),
    syncAddress: b.readUInt16BE(109),
    sequence: b.readUInt8(111),
    options: b.readUInt8(112),
    universe: b.readUInt16BE(113),
    startCode: b.readUInt8(125),
    slots: [...b.subarray(126)],
  };
}
