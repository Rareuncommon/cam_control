// Parameter tables: what a PTZ camera can be asked, described as data.
//
// Each driver ships one table per model. A table entry is everything the panel,
// Companion and the SKAARHOJ mapping need to show and change one setting —
// label, group, type, options or range, how dangerous it is — plus a `wire`
// descriptor that only the driver reads. The browser never sees `wire`.
//
// Doing it this way is what makes "everything the web UI does" tractable across
// four vendors: the settings page, its search, the generic Companion action and
// the panel encoders are each written once, against this shape, rather than
// once per camera.

/** Groups in the order the settings page shows them. Vendors' web UIs mostly agree on this order. */
export const GROUPS = Object.freeze([
  { id: 'camera', label: 'Camera' },
  { id: 'exposure', label: 'Exposure' },
  { id: 'whiteBalance', label: 'White balance' },
  { id: 'image', label: 'Image' },
  { id: 'lens', label: 'Focus & zoom' },
  { id: 'ptz', label: 'Pan / tilt' },
  { id: 'presets', label: 'Presets' },
  { id: 'tracking', label: 'Tracking & framing' },
  { id: 'videoOut', label: 'Video output' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'audio', label: 'Audio' },
  { id: 'tally', label: 'Tally' },
  { id: 'network', label: 'Network' },
  { id: 'users', label: 'Users' },
  { id: 'system', label: 'System' },
  { id: 'maintenance', label: 'Maintenance' },
]);
const GROUP_IDS = new Set(GROUPS.map((g) => g.id));

export const TYPES = Object.freeze(['enum', 'range', 'bool', 'text', 'action']);

/**
 * How much harm a write can do. Decides who may make it and how.
 *
 * - none       part of running a shoot
 * - reconnect  changes how CamBridge reaches the camera (IP, port, protocol switch)
 * - admin      outlasts the shoot: users, passwords, firmware, reboot, reset
 */
export const DANGER = Object.freeze(['none', 'reconnect', 'admin']);

/**
 * Checks a table. Drivers' tests call this, so a typo in a 300-row table fails
 * a test rather than producing a settings page with a blank dropdown.
 *
 * @returns {string[]} problems, empty when the table is sound
 */
export function validateTable(entries) {
  const problems = [];
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    const at = `entry ${i} (${e?.id ?? '?'})`;
    if (!e || typeof e !== 'object') { problems.push(`${at}: not an object`); continue; }
    if (!/^[a-z][A-Za-z0-9]*$/.test(e.id ?? '')) problems.push(`${at}: id must be camelCase`);
    if (seen.has(e.id)) problems.push(`${at}: duplicate id`);
    seen.add(e.id);
    if (!GROUP_IDS.has(e.group)) problems.push(`${at}: unknown group "${e.group}"`);
    if (!TYPES.includes(e.type)) problems.push(`${at}: unknown type "${e.type}"`);
    if (!e.label) problems.push(`${at}: no label`);
    if (e.danger !== undefined && !DANGER.includes(e.danger)) problems.push(`${at}: unknown danger "${e.danger}"`);
    if (e.type === 'enum') {
      if (!Array.isArray(e.options) || e.options.length === 0) problems.push(`${at}: enum without options`);
      else {
        const values = new Set();
        for (const o of e.options) {
          if (o.value === undefined || !o.label) problems.push(`${at}: option needs value and label`);
          const k = String(o.value);
          if (values.has(k)) problems.push(`${at}: duplicate option ${k}`);
          values.add(k);
        }
      }
    }
    if (e.type === 'range') {
      const r = e.range;
      if (!r || !Number.isFinite(r.min) || !Number.isFinite(r.max) || r.min > r.max) {
        problems.push(`${at}: range needs finite min <= max`);
      }
    }
  }
  return problems;
}

const TRUE = new Set([true, 1, '1', 'on', 'On', 'ON', 'true']);
const FALSE = new Set([false, 0, '0', 'off', 'Off', 'OFF', 'false']);

/**
 * Turns whatever a client sent into a value this entry accepts, or says why not.
 *
 * Lenient about form — "1", 1 and true are the same bool; an enum matches on
 * value or label — and strict about substance: nothing outside the options or
 * the range reaches a driver. Range values snap to the step, the same way a
 * camera's own dial would.
 */
export function coerce(entry, value) {
  if (!entry) return { ok: false, error: 'unknown setting' };
  if (entry.readOnly) return { ok: false, error: `${entry.label} is read-only` };
  switch (entry.type) {
    case 'bool':
      if (TRUE.has(value)) return { ok: true, value: true };
      if (FALSE.has(value)) return { ok: true, value: false };
      return { ok: false, error: `${entry.label} is on or off` };
    case 'enum': {
      const hit = entry.options.find((o) => o.value === value)
        ?? entry.options.find((o) => String(o.value) === String(value))
        ?? entry.options.find((o) => String(o.label).toLowerCase() === String(value).toLowerCase());
      return hit ? { ok: true, value: hit.value }
        : { ok: false, error: `${entry.label} has no option "${value}"` };
    }
    case 'range': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `${entry.label} needs a number` };
      const { min, max, step } = entry.range;
      if (n < min || n > max) return { ok: false, error: `${entry.label} goes from ${min} to ${max}` };
      const v = step > 0 ? min + Math.round((n - min) / step) * step : n;
      // Floating steps (0.1 dB) accumulate error; round to the step's precision.
      const decimals = step > 0 ? (String(step).split('.')[1]?.length ?? 0) : 6;
      return { ok: true, value: Number(v.toFixed(decimals)) };
    }
    case 'text': {
      if (value === null || value === undefined) return { ok: false, error: `${entry.label} needs text` };
      const s = String(value);
      if (entry.maxLength && s.length > entry.maxLength) {
        return { ok: false, error: `${entry.label} is at most ${entry.maxLength} characters` };
      }
      if (entry.pattern && !new RegExp(entry.pattern).test(s)) {
        return { ok: false, error: `${entry.label} is not in the expected form` };
      }
      return { ok: true, value: s };
    }
    case 'action':
      return { ok: false, error: `${entry.label} is an action, not a setting` };
    default:
      return { ok: false, error: `cannot set ${entry.label}` };
  }
}

/** What a value looks like to a person. Total: an unexpected value prints as itself. */
export function labelFor(entry, value) {
  if (value === null || value === undefined) return '—';
  if (!entry) return String(value);
  switch (entry.type) {
    case 'enum': {
      const o = entry.options.find((x) => String(x.value) === String(value));
      return o ? o.label : String(value);
    }
    case 'bool': return value ? 'On' : 'Off';
    case 'range': return entry.range?.unit ? `${value}${entry.range.unit}` : String(value);
    case 'text': return entry.secret ? '••••••' : String(value);
    default: return String(value);
  }
}

/** The table as the browser gets it: no wire details, nothing a driver uses privately. */
export function publicSchema(entries) {
  return entries.map(({ wire, ...rest }) => rest);
}

/** Whether an entry belongs behind the admin route. */
export function needsAdmin(entry) {
  return !!entry && (entry.danger === 'admin' || entry.danger === 'reconnect');
}
