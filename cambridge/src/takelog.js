// Take log — what actually rolled, and for how long.
//
// The daemon log already records every record command and every state change;
// this turns that stream into the question a producer asks on the way out of a
// shoot: *did all three cameras get that?*
//
// Pure formatting over the raw transitions the state model collects, for the
// same reason alarms.js is pure — a report that needs a live camera to produce
// is a report nobody runs.

import { humanDuration } from './alarms.js';

/**
 * @typedef {object} Take
 * @property {string} cameraId
 * @property {string} label
 * @property {number} startedAt
 * @property {number|null} endedAt   null while still rolling
 * @property {boolean|null} dropped  true = stopped unasked, null = camera went
 *                                   offline and we cannot know
 */

/** Seconds a take ran, or has been running. */
export function takeDuration(take, now = Date.now()) {
  if (!take?.startedAt) return 0;
  return Math.max(0, Math.round(((take.endedAt ?? now) - take.startedAt) / 1000));
}

function outcomeOf(take) {
  if (take.endedAt === null) return 'rolling';
  if (take.dropped === null) return 'unknown';
  return take.dropped ? 'dropped' : 'ok';
}

const OUTCOME_TEXT = {
  rolling: 'still rolling',
  ok: 'stopped normally',
  dropped: 'stopped on its own',
  unknown: 'camera went offline while rolling',
};

/** One take, decorated for display. */
export function describeTake(take, now = Date.now()) {
  const outcome = outcomeOf(take);
  return {
    cameraId: take.cameraId,
    label: take.label,
    startedAt: take.startedAt,
    endedAt: take.endedAt,
    seconds: takeDuration(take, now),
    duration: humanDuration(takeDuration(take, now)),
    outcome,
    outcomeText: OUTCOME_TEXT[outcome],
  };
}

/**
 * Groups takes that started close together into one row per "take".
 *
 * Rolling three cameras produces three separate records that are, to everyone
 * involved, one take. Grouping by start time within a window is what makes the
 * report readable — and makes the useful column possible: which cameras were
 * *missing* from a take that everything else caught.
 *
 * @param {Take[]} takes
 * @param {number} windowMs how far apart two starts can be and still be one take
 */
export function groupTakes(takes, { windowMs = 10_000, now = Date.now() } = {}) {
  const sorted = [...(takes ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  const groups = [];
  for (const take of sorted) {
    const last = groups[groups.length - 1];
    if (last && take.startedAt - last.startedAt <= windowMs) {
      last.cameras.push(describeTake(take, now));
    } else {
      groups.push({ startedAt: take.startedAt, cameras: [describeTake(take, now)] });
    }
  }
  return groups.map((g, i) => ({
    take: i + 1,
    startedAt: g.startedAt,
    cameras: g.cameras.sort((a, b) => a.label.localeCompare(b.label)),
    // The longest camera in the group is the take's length; a body that dropped
    // out early should not shorten what the take is reported as.
    seconds: Math.max(...g.cameras.map((c) => c.seconds)),
    duration: humanDuration(Math.max(...g.cameras.map((c) => c.seconds))),
    faults: g.cameras.filter((c) => c.outcome === 'dropped' || c.outcome === 'unknown'),
  }));
}

/**
 * The report.
 *
 * `missing` is the column worth having: cameras that were part of other takes
 * but not this one. A camera that never rolled all day is a different problem
 * from a camera that missed take four, and only comparing across takes can tell
 * them apart.
 */
export function report(takes, { now = Date.now(), windowMs = 10_000 } = {}) {
  const groups = groupTakes(takes, { windowMs, now });
  const everySeen = new Map();
  for (const g of groups) {
    for (const c of g.cameras) everySeen.set(c.cameraId, c.label);
  }

  const rows = groups.map((g) => {
    const present = new Set(g.cameras.map((c) => c.cameraId));
    const missing = [...everySeen.entries()]
      .filter(([id]) => !present.has(id))
      .map(([id, label]) => ({ cameraId: id, label }));
    return { ...g, missing };
  });

  return {
    takes: rows,
    cameras: [...everySeen.entries()].map(([cameraId, label]) => ({ cameraId, label })),
    faults: rows.reduce((n, r) => n + r.faults.length + r.missing.length, 0),
  };
}

/**
 * Are all the cameras that should be rolling, rolling?
 *
 * Answers only for connected cameras. An offline camera has its own, louder
 * alarm, and folding it in here would turn "all rolling" into a claim about
 * bodies we cannot see.
 */
export function rollState(cameras) {
  const connected = (cameras ?? []).filter((c) => c.state === 'connected' && c.capabilities?.record?.available !== false);
  const rolling = connected.filter((c) => c.status?.recording);
  return {
    total: connected.length,
    rolling: rolling.length,
    all: connected.length > 0 && rolling.length === connected.length,
    some: rolling.length > 0 && rolling.length < connected.length,
    idle: rolling.length === 0,
    notRolling: connected
      .filter((c) => !c.status?.recording)
      .map((c) => ({ cameraId: c.id, label: c.label || c.id })),
  };
}
