// Panel access control.
//
// Until now the panel had none: anyone who could reach the port had full
// control of three cameras during a shoot, and could read and rewrite the
// access-authentication credentials stored against each body. On a dedicated
// production VLAN that is survivable; with several operators and a laptop that
// has been on other networks, it is not.
//
// Three decisions shape this file, and each of them is about not making the
// failure mode worse than the problem:
//
// **A studio with no PIN configured stays open.** Locking the panel as a side
// effect of an upgrade — on a shoot day, with no way in — would be a far worse
// outcome than the exposure it prevents. Unconfigured means unprotected, said
// out loud in the UI, with a way to fix it.
//
// **Machine clients use a token, not the PIN.** Companion runs on another host
// and cannot answer a login prompt. A loopback-only exemption was the obvious
// alternative and is wrong: it breaks every remote Companion install while
// still trusting anything that manages to reach the port from localhost.
//
// **Roles split on damage, not on seniority.** An operator can do anything that
// affects a shoot in progress and nothing that outlasts it. Adopting and
// removing cameras, reading credentials and quitting the app are admin, because
// those are the actions whose consequences survive the person who took them.

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/** Sessions last a working day; a booth iPad should not log in twice a shoot. */
export const SESSION_TTL_MS = 16 * 60 * 60 * 1000;

const COOKIE = 'cambridge_session';

/** Deliberately slow. scrypt's defaults are the point of using it. */
export function hashPin(pin, salt = randomBytes(16).toString('hex')) {
  const derived = scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash: derived };
}

/**
 * Constant-time comparison.
 *
 * A plain === leaks the length of the matching prefix through timing, which for
 * a four-digit PIN over a LAN is not academic.
 */
export function pinMatches(pin, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const candidate = Buffer.from(scryptSync(String(pin), stored.salt, 32).toString('hex'));
  const known = Buffer.from(String(stored.hash));
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

/**
 * Routes only an admin may take.
 *
 * Matched as regexes against `METHOD /path` so the list reads as the thing it
 * is — a list of actions that outlast a shoot — rather than being scattered
 * through the router as individual checks that can be forgotten when a route
 * is added.
 */
export const ADMIN_ROUTES = [
  /^POST \/api\/adopt$/,               // stores camera credentials
  /^(DELETE|PATCH|PUT) \/api\/cameras\/[^/]+$/, // forgets or re-credentials a body
  /^POST \/api\/shutdown$/,            // stops the app for everyone
  /^POST \/api\/auth\/pin$/,           // changes who can get in
];

/** Routes anyone may take, PIN or not — the login flow itself, and health. */
export const PUBLIC_ROUTES = [
  /^POST \/api\/auth\/login$/,
  /^GET \/api\/auth\/state$/,
  /^GET \/api\/health$/,
];

export function requiredRole(method, path) {
  const key = `${method} ${path}`;
  if (PUBLIC_ROUTES.some((r) => r.test(key))) return 'public';
  if (ADMIN_ROUTES.some((r) => r.test(key))) return 'admin';
  return 'operator';
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = decodeURIComponent(part.slice(at + 1).trim());
  }
  return out;
}

export class Auth {
  /**
   * @param {object} cfg      the `auth` block from the config
   * @param {(level: string, subject: string, msg: string) => void} [log]
   */
  constructor(cfg = {}, log = () => {}) {
    this.log = log;
    this.operatorPin = cfg.operatorPin ?? null;   // { salt, hash }
    this.adminPin = cfg.adminPin ?? null;
    this.tokens = cfg.tokens ?? {};               // { token: 'operator' | 'admin' }
    /** @type {Map<string, {role: string, expires: number, label: string}>} */
    this.sessions = new Map();
  }

  /**
   * With no PIN set at all, the panel is open and says so.
   *
   * Note this is about *PINs*, not tokens: configuring a token for Companion
   * must not silently lock out every human at the same time.
   */
  get enabled() { return !!(this.operatorPin || this.adminPin); }

  /** What the login page needs to know before anyone types anything. */
  state() {
    return {
      enabled: this.enabled,
      hasAdmin: !!this.adminPin,
      // The banner text lives with the rule that produces it, so they cannot
      // drift into disagreeing about whether the panel is protected.
      warning: this.enabled ? null
        : 'Anyone on this network can control the cameras and read their '
          + 'passwords. Set a PIN in Setup.',
    };
  }

  #issue(role, label) {
    const id = randomBytes(24).toString('hex');
    this.sessions.set(id, { role, label, expires: Date.now() + SESSION_TTL_MS });
    return id;
  }

  /** Drops expired sessions. Called on each lookup; the map stays small. */
  #sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (s.expires <= now) this.sessions.delete(id);
  }

  /**
   * @returns {{ok: boolean, cookie?: string, role?: string, error?: string}}
   */
  login(pin) {
    if (!this.enabled) return { ok: true, role: 'admin', open: true };
    // Admin is checked first so that setting the same PIN for both does not
    // silently demote whoever configured it.
    if (this.adminPin && pinMatches(pin, this.adminPin)) {
      return { ok: true, role: 'admin', cookie: this.#issue('admin', 'admin') };
    }
    if (this.operatorPin && pinMatches(pin, this.operatorPin)) {
      return { ok: true, role: 'operator', cookie: this.#issue('operator', 'operator') };
    }
    return { ok: false, error: 'That PIN was not recognised.' };
  }

  logout(cookieId) { return this.sessions.delete(cookieId); }

  /**
   * Identifies a request.
   *
   * Returns the role it carries and a short label for the audit log. An open
   * panel reports 'anonymous' rather than pretending to know who acted — the
   * log should not imply an identity that was never checked.
   */
  identify(req) {
    if (!this.enabled) {
      // Tokens still identify themselves on an open panel, so a Companion
      // action is attributable even before a PIN is set.
      const token = this.#tokenOf(req);
      if (token) return { role: 'admin', label: token.label, via: 'token' };
      return { role: 'admin', label: 'anonymous', via: 'open' };
    }

    const token = this.#tokenOf(req);
    if (token) return { role: token.role, label: token.label, via: 'token' };

    this.#sweep();
    const id = parseCookies(req.headers?.cookie)[COOKIE];
    const session = id ? this.sessions.get(id) : null;
    if (session) return { role: session.role, label: session.label, via: 'session', id };
    return { role: null, label: 'unauthenticated', via: 'none' };
  }

  #tokenOf(req) {
    const header = req.headers?.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const presented = m ? m[1].trim() : null;
    if (!presented) return null;
    for (const [token, role] of Object.entries(this.tokens)) {
      // Same constant-time reasoning as the PIN. A token is longer, but it is
      // also compared far more often — every Companion poll.
      const a = Buffer.from(presented);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return { role, label: `token:${shortId(token)}` };
      }
    }
    return null;
  }

  /**
   * @returns {{allowed: boolean, status?: number, error?: string, who: object}}
   */
  authorise(method, path, req) {
    const need = requiredRole(method, path);
    const who = this.identify(req);
    if (need === 'public') return { allowed: true, who };
    if (!this.enabled) return { allowed: true, who };

    if (!who.role) {
      return { allowed: false, status: 401, error: 'Sign in to control the cameras.', who };
    }

    // With no admin PIN configured there is no admin, so an admin requirement
    // cannot be satisfied by anybody. Enforcing it anyway is a lockout: set the
    // operator PIN first and the admin PIN can never be set afterwards, because
    // setting it is itself an admin route. The config would have to be edited by
    // hand to recover, on a machine whose whole point is not needing that.
    //
    // So: one PIN configured means one level of access. The split takes effect
    // the moment an admin PIN exists, and not before.
    if (need === 'admin' && !this.adminPin) return { allowed: true, who };

    if (need === 'admin' && who.role !== 'admin') {
      return {
        allowed: false,
        status: 403,
        // Says what to do about it. "Forbidden" on a shoot day is a support call.
        error: 'That needs the admin PIN — it changes something that outlasts this shoot.',
        who,
      };
    }
    return { allowed: true, who };
  }

  static cookieHeader(id, { secure = false } = {}) {
    const bits = [
      `${COOKIE}=${id}`,
      'Path=/',
      'HttpOnly',
      // Lax, not Strict: Strict drops the cookie on a link opened from another
      // app, which is exactly how the booth iPad's shortcut opens the panel.
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) bits.push('Secure');
    return bits.join('; ');
  }

  static clearCookieHeader() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}

/** Short, non-reversible tag for the audit log — never the token itself. */
export function shortId(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}
