// HTTP for PTZ cameras: Basic and Digest auth, hard timeouts, no dependencies.
//
// Built on node:http rather than fetch for one reason: embedded camera web
// servers are not always strict about HTTP. undici (behind fetch) rejects a
// malformed header outright, and "the camera answered but Node refused to read
// it" is a miserable thing to diagnose on site. node:http with the lenient
// parser reads what the camera actually sent.
//
// Never throws. Every outcome — answer, refusal, timeout, unreachable — comes
// back as a plain object, because a camera that stops answering is an ordinary
// event here, not an exception.

import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Per-host caches are bounded. A bulk add probes up to 256 addresses, and a
 * venue runs for weeks; neither should leave a pool or a challenge behind for
 * every address ever tried.
 */
const MAX_HOSTS = 512;
function remember(map, key, value, onEvict) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_HOSTS) {
    const [oldKey, oldValue] = map.entries().next().value;
    map.delete(oldKey);
    onEvict?.(oldValue);
  }
}

/** One keep-alive pool per camera host, so polling does not open a socket per query. */
const agents = new Map();
function agentFor(host) {
  let a = agents.get(host);
  if (!a) {
    // Cameras commonly limit simultaneous connections, and the lifecycle queue
    // sends one command at a time anyway; a second socket would only matter for
    // a snapshot fetched alongside a poll.
    a = new http.Agent({ keepAlive: true, maxSockets: 2, keepAliveMsecs: 5000 });
    remember(agents, host, a, (old) => old.destroy());
  }
  return a;
}

/**
 * The scheme each host has authenticated with. A host that has used Digest
 * and then asks for Basic does not get the password: Basic sends it in the
 * clear, and the likeliest reason for the change is that the address now
 * belongs to something else (a DHCP lease reused) — or is pretending.
 */
const schemes = new Map();

/**
 * Parses a WWW-Authenticate header.
 *
 * Handles quoted values containing commas (`qop="auth,auth-int"`), which a
 * naive split on commas gets wrong.
 */
export function parseChallenge(header) {
  if (!header) return null;
  const text = Array.isArray(header) ? header.join(', ') : String(header);
  const m = /^\s*(\w+)\s+(.*)$/s.exec(text);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const params = {};
  const re = /(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let p;
  while ((p = re.exec(m[2])) !== null) {
    params[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  }
  return { scheme, params };
}

function hashFor(algorithm) {
  const a = String(algorithm || 'MD5').toUpperCase().replace(/-SESS$/, '');
  if (a === 'SHA-256') return (s) => createHash('sha256').update(s).digest('hex');
  return (s) => createHash('md5').update(s).digest('hex');
}

/**
 * Builds a Digest Authorization header (RFC 7616 / 2617).
 *
 * Exported for tests: the digest arithmetic is the part most likely to be wrong
 * in a way that looks like "wrong password", so it is checked against the
 * worked example in RFC 2617 rather than only against our own fake.
 */
export function digestHeader({ username, password, method, uri, challenge, nc = 1, cnonce }) {
  const p = challenge.params;
  const H = hashFor(p.algorithm);
  const sess = /-sess$/i.test(p.algorithm ?? '');
  const qop = p.qop
    ? (p.qop.split(',').map((s) => s.trim()).includes('auth') ? 'auth' : p.qop.split(',')[0].trim())
    : null;
  const cn = cnonce ?? randomBytes(8).toString('hex');
  const ncHex = nc.toString(16).padStart(8, '0');

  let ha1 = H(`${username}:${p.realm ?? ''}:${password}`);
  if (sess) ha1 = H(`${ha1}:${p.nonce}:${cn}`);
  const ha2 = H(`${method}:${uri}`);
  const response = qop
    ? H(`${ha1}:${p.nonce}:${ncHex}:${cn}:${qop}:${ha2}`)
    : H(`${ha1}:${p.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${p.realm ?? ''}"`,
    `nonce="${p.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (p.algorithm) parts.push(`algorithm=${p.algorithm}`);
  if (p.opaque !== undefined) parts.push(`opaque="${p.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cn}"`);
  return `Digest ${parts.join(', ')}`;
}

/**
 * Remembers the last Digest challenge per host so that every request after the
 * first goes out already authenticated. Without this, each poll would cost two
 * round trips — the 401 and the retry — on a camera that may also be rate
 * limiting commands.
 */
const digestCache = new Map();
const cacheDigest = (key, value) => remember(digestCache, key, value);

function rawRequest({ host, port, method, path, headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({
      host,
      port,
      method,
      path,
      headers,
      agent: agentFor(`${host}:${port}`),
      insecureHTTPParser: true,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', (err) => done({ ok: false, status: 0, error: `read failed: ${err.message}`, kind: 'network' }));
    });
    // A hard deadline on the whole exchange, not just socket inactivity: a
    // camera that trickles a reply must still be called slow.
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, status: 0, error: `no answer within ${timeoutMs}ms`, kind: 'timeout' });
    }, timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, status: 0, error: err.code ? `${err.code} ${err.message}` : err.message, kind: 'network' });
    });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * One HTTP exchange with a camera.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} [o.port=80]
 * @param {string} [o.method='GET']
 * @param {string} o.path            path and query, already encoded
 * @param {{username?: string, password?: string}} [o.auth]
 * @param {Buffer|string} [o.body]
 * @param {object} [o.headers]
 * @param {number} [o.timeoutMs=3000]
 * @returns {Promise<{ok: boolean, status: number, headers?: object, body?: Buffer, text?: string, error?: string, kind?: string}>}
 */
export async function request(o) {
  const host = o.host;
  const port = o.port ?? 80;
  const method = o.method ?? 'GET';
  const timeoutMs = o.timeoutMs ?? 3000;
  const key = `${host}:${port}`;
  const headers = { ...(o.headers ?? {}) };
  const body = o.body === undefined ? undefined : Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body));
  if (body) headers['Content-Length'] = body.length;
  const user = o.auth?.username;
  const pass = o.auth?.password ?? '';

  const authorise = () => {
    if (!user) return;
    const cached = digestCache.get(key);
    if (cached) {
      cached.nc += 1;
      headers.Authorization = digestHeader({
        username: user, password: pass, method, uri: o.path, challenge: cached.challenge, nc: cached.nc,
      });
    } else if (o.preferBasic && !o.noBasic && schemes.get(key) !== 'digest') {
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
  };

  authorise();
  let r = await rawRequest({ host, port, method, path: o.path, headers, body, timeoutMs });

  if (r.status === 401 && user) {
    const challenge = parseChallenge(r.headers['www-authenticate']);
    if (challenge?.scheme === 'digest') {
      remember(schemes, key, 'digest');
      cacheDigest(key, { challenge, nc: 1 });
      headers.Authorization = digestHeader({ username: user, password: pass, method, uri: o.path, challenge, nc: 1 });
      r = await rawRequest({ host, port, method, path: o.path, headers, body, timeoutMs });
      // A stale nonce answers 401 again with stale=true; one more try with the
      // fresh challenge, then give up rather than loop.
      if (r.status === 401) {
        const again = parseChallenge(r.headers['www-authenticate']);
        if (again?.scheme === 'digest' && /^true$/i.test(again.params.stale ?? '')) {
          cacheDigest(key, { challenge: again, nc: 1 });
          headers.Authorization = digestHeader({ username: user, password: pass, method, uri: o.path, challenge: again, nc: 1 });
          r = await rawRequest({ host, port, method, path: o.path, headers, body, timeoutMs });
        }
      }
    } else if (challenge?.scheme === 'basic') {
      // Never in a scan (the password would go to every device in the range
      // that asks), and never to a host that has used Digest before.
      if (o.noBasic || schemes.get(key) === 'digest') {
        return {
          ...r, ok: false, kind: 'auth',
          error: o.noBasic
            ? 'the device asked for Basic authentication, which a scan does not send'
            : 'the camera asked for Basic after using Digest — the password was not sent',
        };
      }
      digestCache.delete(key);
      remember(schemes, key, 'basic');
      headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      r = await rawRequest({ host, port, method, path: o.path, headers, body, timeoutMs });
    }
  }

  if (r.status === 401) {
    digestCache.delete(key);
    return { ...r, ok: false, kind: 'auth', error: 'the camera refused the username or password' };
  }
  if (r.body) r.text = r.body.toString('utf8');
  if (!r.ok && !r.error) r.error = `HTTP ${r.status}`;
  return r;
}

/**
 * The scheme a host has authenticated ordinary requests with, if any. For
 * drivers with a connection of their own (Canon's event stream), so they keep
 * the same rule: a host that used Digest never gets the password in Basic.
 */
export function knownScheme(host, port = 80) {
  return schemes.get(`${host}:${port}`) ?? null;
}

/** Forgets cached credentials for a host — after a password change, say. */
export function forgetHost(host, port = 80) {
  digestCache.delete(`${host}:${port}`);
  schemes.delete(`${host}:${port}`);
  const a = agents.get(`${host}:${port}`);
  if (a) { a.destroy(); agents.delete(`${host}:${port}`); }
}
