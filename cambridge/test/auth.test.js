// Panel access control.
//
// The cases that matter here are the ones where getting it wrong is worse than
// having no auth at all: locking out a booth mid-shoot, or leaving something
// open that reads as closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Auth, hashPin, pinMatches, requiredRole, parseCookies, shortId, SESSION_TTL_MS,
} from '../src/auth.js';

const req = (headers = {}) => ({ headers, socket: { remoteAddress: '10.0.0.9' } });
const withCookie = (id) => req({ cookie: `cambridge_session=${id}` });
const withToken = (t) => req({ authorization: `Bearer ${t}` });

// --- PIN hashing ------------------------------------------------------------

test('a PIN is stored salted and hashed, never in the clear', () => {
  const stored = hashPin('2468');
  assert.ok(stored.salt && stored.hash);
  assert.ok(!JSON.stringify(stored).includes('2468'));
  assert.ok(pinMatches('2468', stored));
  assert.ok(!pinMatches('2469', stored));
});

test('the same PIN hashes differently for two studios', () => {
  // Without a per-PIN salt, two installations with the same PIN would have the
  // same hash, and one leaked config would read the other.
  assert.notEqual(hashPin('1234').hash, hashPin('1234').hash);
});

test('a malformed stored PIN is a mismatch, not a crash or a free pass', () => {
  assert.ok(!pinMatches('1234', null));
  assert.ok(!pinMatches('1234', {}));
  assert.ok(!pinMatches('1234', { salt: 'x' }));
});

// --- route classification ---------------------------------------------------

test('anything that outlasts a shoot needs admin', () => {
  assert.equal(requiredRole('POST', '/api/adopt'), 'admin');
  assert.equal(requiredRole('DELETE', '/api/cameras/fx3'), 'admin');
  assert.equal(requiredRole('PATCH', '/api/cameras/fx3'), 'admin');
  assert.equal(requiredRole('POST', '/api/shutdown'), 'admin');
  assert.equal(requiredRole('POST', '/api/auth/pin'), 'admin');
});

test('everything that only affects the shoot in progress is operator', () => {
  for (const [method, path] of [
    ['PUT', '/api/cameras/fx3/properties/fNumber'],
    ['POST', '/api/cameras/fx3/actions/recordStart'],
    ['POST', '/api/record-all'],
    ['POST', '/api/scenes/Interview'],
    ['POST', '/api/cameras/fx3/undo'],
    ['GET', '/api/state'],
  ]) {
    assert.equal(requiredRole(method, path), 'operator', `${method} ${path}`);
  }
});

test('the login flow itself is reachable without being logged in', () => {
  assert.equal(requiredRole('POST', '/api/auth/login'), 'public');
  assert.equal(requiredRole('GET', '/api/auth/state'), 'public');
  assert.equal(requiredRole('GET', '/api/health'), 'public');
});

test('a property write is not mistaken for a camera edit', () => {
  // PUT /api/cameras/:id is admin (it rewrites stored credentials); PUT
  // /api/cameras/:id/properties/:prop is the commonest operator action there
  // is. A pattern that caught both would lock every operator out of the iris.
  assert.equal(requiredRole('PUT', '/api/cameras/fx3'), 'admin');
  assert.equal(requiredRole('PUT', '/api/cameras/fx3/properties/fNumber'), 'operator');
});

// --- open panel -------------------------------------------------------------

test('with no PIN configured the panel is open and says so', () => {
  // Locking the panel as a side effect of an upgrade, on a shoot day, with no
  // way in, would be far worse than the exposure it prevents.
  const auth = new Auth({});
  assert.equal(auth.enabled, false);
  assert.match(auth.state().warning, /Anyone on this network/);
  assert.equal(auth.authorise('POST', '/api/adopt', req()).allowed, true);
  assert.equal(auth.authorise('POST', '/api/record-all', req()).allowed, true);
});

test('configuring a token alone does not lock out every human', () => {
  // Tokens are for machines. Treating one as "auth is on" would leave the booth
  // staring at a PIN box for a PIN nobody set.
  const auth = new Auth({ tokens: { abc123: 'operator' } });
  assert.equal(auth.enabled, false);
  assert.equal(auth.authorise('POST', '/api/record-all', req()).allowed, true);
});

test('an open panel logs actions as anonymous rather than inventing a name', () => {
  const auth = new Auth({});
  assert.equal(auth.identify(req()).label, 'anonymous');
});

// --- with a PIN -------------------------------------------------------------

function protectedAuth() {
  return new Auth({
    operatorPin: hashPin('1111'),
    adminPin: hashPin('9999'),
    tokens: { 'tok-operator': 'operator', 'tok-admin': 'admin' },
  });
}

test('no credentials means 401, with something actionable to read', () => {
  const auth = protectedAuth();
  const v = auth.authorise('POST', '/api/record-all', req());
  assert.equal(v.allowed, false);
  assert.equal(v.status, 401);
  assert.match(v.error, /Sign in/);
});

test('a wrong PIN is refused', () => {
  assert.equal(protectedAuth().login('0000').ok, false);
});

test('an operator PIN gets a session that can drive a shoot', () => {
  const auth = protectedAuth();
  const login = auth.login('1111');
  assert.equal(login.role, 'operator');
  assert.equal(auth.authorise('POST', '/api/record-all', withCookie(login.cookie)).allowed, true);
});

test('an operator cannot do the things that outlast a shoot', () => {
  const auth = protectedAuth();
  const { cookie } = auth.login('1111');
  const v = auth.authorise('POST', '/api/adopt', withCookie(cookie));
  assert.equal(v.allowed, false);
  assert.equal(v.status, 403);
  // 403, not 401: the session is fine and re-logging in would not help, so the
  // message has to say which PIN is needed rather than "forbidden".
  assert.match(v.error, /admin PIN/);
});

test('an admin PIN can do both', () => {
  const auth = protectedAuth();
  const { cookie, role } = auth.login('9999');
  assert.equal(role, 'admin');
  assert.equal(auth.authorise('POST', '/api/adopt', withCookie(cookie)).allowed, true);
  assert.equal(auth.authorise('POST', '/api/record-all', withCookie(cookie)).allowed, true);
});

test('one PIN set for both roles signs in as admin, not operator', () => {
  const same = hashPin('4242');
  const auth = new Auth({ operatorPin: same, adminPin: same });
  assert.equal(auth.login('4242').role, 'admin');
});

test('an unknown session cookie is not a session', () => {
  const auth = protectedAuth();
  assert.equal(auth.authorise('GET', '/api/state', withCookie('made-up')).allowed, false);
});

test('signing out ends the session immediately', () => {
  const auth = protectedAuth();
  const { cookie } = auth.login('1111');
  assert.equal(auth.authorise('GET', '/api/state', withCookie(cookie)).allowed, true);
  auth.logout(cookie);
  assert.equal(auth.authorise('GET', '/api/state', withCookie(cookie)).allowed, false);
});

test('an expired session is refused and forgotten', () => {
  const auth = protectedAuth();
  const { cookie } = auth.login('1111');
  auth.sessions.get(cookie).expires = Date.now() - 1;
  assert.equal(auth.authorise('GET', '/api/state', withCookie(cookie)).allowed, false);
  assert.equal(auth.sessions.has(cookie), false, 'expired sessions must not accumulate');
});

test('a session lasts a working day, so nobody signs in twice a shoot', () => {
  const auth = protectedAuth();
  const { cookie } = auth.login('1111');
  const left = auth.sessions.get(cookie).expires - Date.now();
  assert.ok(left > 15 * 60 * 60 * 1000, 'too short for a shoot day');
  assert.ok(left <= SESSION_TTL_MS);
});

// --- machine clients --------------------------------------------------------

test('a token works with no PIN prompt, from any host', () => {
  // Companion runs on another machine and cannot answer a prompt. A
  // loopback-only exemption would break every remote install while still
  // trusting anything that reaches the port from localhost.
  const auth = protectedAuth();
  const v = auth.authorise('POST', '/api/record-all', withToken('tok-operator'));
  assert.equal(v.allowed, true);
  assert.equal(v.who.via, 'token');
});

test('a token carries only the role it was given', () => {
  const auth = protectedAuth();
  assert.equal(auth.authorise('POST', '/api/adopt', withToken('tok-operator')).allowed, false);
  assert.equal(auth.authorise('POST', '/api/adopt', withToken('tok-admin')).allowed, true);
});

test('an unknown token is refused', () => {
  assert.equal(protectedAuth().authorise('GET', '/api/state', withToken('nope')).allowed, false);
});

test('the audit label identifies a token without disclosing it', () => {
  const auth = protectedAuth();
  const who = auth.identify(withToken('tok-admin'));
  assert.match(who.label, /^token:[0-9a-f]{8}$/);
  assert.ok(!who.label.includes('tok-admin'));
  assert.equal(shortId('tok-admin'), shortId('tok-admin'), 'and is stable');
});

// --- cookies ----------------------------------------------------------------

test('the session cookie is HttpOnly and SameSite=Lax', () => {
  const header = Auth.cookieHeader('abc');
  assert.match(header, /HttpOnly/);
  // Lax rather than Strict: Strict drops the cookie on a link opened from
  // another app, which is exactly how the booth iPad's shortcut opens the panel.
  assert.match(header, /SameSite=Lax/);
  assert.ok(!/Secure/.test(header), 'the studio LAN is plain HTTP');
  assert.match(Auth.clearCookieHeader(), /Max-Age=0/);
});

test('cookie parsing survives the junk browsers actually send', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('novalue; a=1'), { a: '1' });
  assert.equal(parseCookies('a=hello%20there').a, 'hello there');
});

// --- bootstrap ---------------------------------------------------------------

test('setting the operator PIN first does not lock the admin PIN out forever', () => {
  // The lockout this prevents: enabling auth with only an operator PIN makes
  // every admin route unreachable, and setting the admin PIN is itself an admin
  // route. Recovery would mean hand-editing the config on a machine whose whole
  // point is not needing that.
  const auth = new Auth({ operatorPin: hashPin('1111') });
  const { cookie, role } = auth.login('1111');
  assert.equal(role, 'operator');
  assert.equal(auth.authorise('POST', '/api/auth/pin', withCookie(cookie)).allowed, true);
  assert.equal(auth.authorise('POST', '/api/adopt', withCookie(cookie)).allowed, true);
});

test('the operator/admin split takes effect the moment an admin PIN exists', () => {
  const auth = new Auth({ operatorPin: hashPin('1111') });
  const { cookie } = auth.login('1111');
  assert.equal(auth.authorise('POST', '/api/adopt', withCookie(cookie)).allowed, true);

  auth.adminPin = hashPin('9999');
  assert.equal(auth.authorise('POST', '/api/adopt', withCookie(cookie)).allowed, false);
  assert.equal(auth.authorise('POST', '/api/record-all', withCookie(cookie)).allowed, true);
});

test('one PIN level still requires that PIN — the fallback is not a bypass', () => {
  const auth = new Auth({ operatorPin: hashPin('1111') });
  assert.equal(auth.authorise('POST', '/api/adopt', req()).allowed, false,
    'unauthenticated must still be refused');
  assert.equal(auth.authorise('POST', '/api/adopt', req()).status, 401);
});
