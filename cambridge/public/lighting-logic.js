// The Lighting tab's decisions, kept free of the DOM so they are tested
// (test/lighting-panel.test.js) rather than eyeballed: what the output pill
// says, where a new fixture should go, which field an API error belongs to.

/**
 * What the header pill and the output card say about sACN output.
 * Quiet when all is well: a pill that is always there is a pill nobody reads.
 *
 * @returns {{text: string, kind: 'ok'|'warn'|'bad'|'', pill: boolean, detail: string}}
 */
export function outputSummary(lighting) {
  if (!lighting) return { text: 'Lighting', kind: '', pill: false, detail: '' };
  if (lighting.unavailable) {
    return { text: 'LIGHTING DOWN', kind: 'bad', pill: true, detail: `Lighting is not running: ${lighting.unavailable}` };
  }
  const o = lighting.output ?? {};
  switch (o.state) {
    case 'off':
      return { text: 'Lighting output off', kind: '', pill: true, detail: 'CamBridge is not sending to the lights.' };
    case 'dry-run':
      return { text: 'LIGHTS: DRY RUN', kind: 'warn', pill: true, detail: 'Dry run: frames are worked out and shown here, but nothing is sent.' };
    case 'error':
      return { text: 'LIGHTS: NO NETWORK', kind: 'bad', pill: true, detail: o.error ?? 'The lighting network is not available.' };
    case 'degraded':
      return { text: 'LIGHTS: SEND ERRORS', kind: 'bad', pill: true, detail: o.error ?? 'Some packets are not getting through.' };
    case 'sending':
      if (o.waitingForState || lighting.known === false) {
        return { text: 'LIGHTS: WAITING', kind: 'warn', pill: true,
          detail: 'Output is on, but nothing has been set yet, so nothing is sent. Recall a look or scene to start.' };
      }
      return { text: 'Lights', kind: 'ok', pill: false, detail: `Sending to ${o.mode === 'multicast' ? 'multicast' : 'each light'} from ${o.bound?.address ?? o.address}.` };
    default:
      return { text: 'Lighting', kind: '', pill: false, detail: '' };
  }
}

/**
 * The first address in `universe` where a fixture of `footprint` channels fits
 * without overlapping anything. Null if the universe is full.
 */
export function nextFreeAddress(fixtures, universe, footprint, skipId = null) {
  const used = fixtures
    .filter((f) => f.id !== skipId && f.universe === universe && Number.isInteger(f.address))
    .map((f) => [f.address, f.address + (f.footprint ?? 1) - 1])
    .sort((a, b) => a[0] - b[0]);
  let at = 1;
  for (const [lo, hi] of used) {
    if (at + footprint - 1 < lo) break;
    at = Math.max(at, hi + 1);
  }
  return at + footprint - 1 <= 512 ? at : null;
}

/**
 * Splits a refused patch change into messages per form field, for the
 * fixture currently being edited. Errors on other fixtures (the other half
 * of an overlap, say) are left in `other`.
 *
 * @param {{fixture?: string, field?: string, message: string}[]} errors
 * @returns {{fields: Record<string, string[]>, other: string[]}}
 */
export function fieldErrors(errors, fixtureId) {
  const fields = {};
  const other = [];
  for (const e of errors ?? []) {
    const message = typeof e === 'string' ? e : e.message;
    if (typeof e === 'object' && e.field && (!fixtureId || e.fixture === fixtureId)) (fields[e.field] ??= []).push(message);
    else other.push(message);
  }
  return { fields, other };
}

/** "Interview · saved 14:32" style label for a scene slot. */
export function sceneCaption(scene, now = new Date()) {
  if (scene.empty) return 'empty';
  if (!scene.savedAt) return 'saved';
  const t = new Date(scene.savedAt);
  if (Number.isNaN(t.getTime())) return 'saved';
  const sameDay = t.toDateString() === now.toDateString();
  const hm = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `saved ${hm}` : `saved ${t.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${hm}`;
}

export const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)} %` : '—');
export const kelvin = (v) => (Number.isFinite(v) ? `${Math.round(v)} K` : '—');

/** The groups field: "Key, Back" → ['Key', 'Back']. */
export function parseGroups(text) {
  return [...new Set(String(text ?? '').split(',').map((g) => g.trim()).filter(Boolean))];
}

/**
 * Sends the latest value at most every `ms` while a fader moves, and always
 * sends the last one. A drag is dozens of input events; the lights only need
 * to follow it, not replay it.
 */
export function throttle(send, ms = 80, { now = () => performance.now(), setTimer = setTimeout } = {}) {
  let timer = null;
  let pending;
  let last = -Infinity;
  const fire = () => {
    timer = null;
    last = now();
    const value = pending;
    pending = undefined;
    send(value);
  };
  return (value) => {
    pending = value;
    if (timer) return;
    timer = setTimer(fire, Math.max(0, ms - (now() - last)));
  };
}
