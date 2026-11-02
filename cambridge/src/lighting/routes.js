// The lighting REST routes, in the same style as the camera API: JSON in and
// out under /api/lighting, answers shaped { ok, … } or { ok: false, error }.
//
// Who may do what is decided in auth.js like every other route (the patch,
// profiles, import and export are admin); the one mixed route, PUT
// /api/lighting/output, is operator-level for on/off and dry-run and passes
// `admin` down so the network settings are refused without the admin PIN.

const SCENE = /^\/api\/lighting\/scenes\/([^/]+)(\/recall)?$/;
const LOOK = /^\/api\/lighting\/looks\/([^/]+)\/recall$/;
const FIXTURE = /^\/api\/lighting\/fixtures\/([^/]+)(\/identify)?$/;
const PROFILE = /^\/api\/lighting\/profiles\/([^/]+)$/;

/**
 * Handles a request if it is a lighting route.
 *
 * @param {object} o
 * @param {import('node:http').IncomingMessage} o.req
 * @param {import('node:http').ServerResponse} o.res
 * @param {string} o.path
 * @param {import('./service.js').Lighting | null} o.lighting   null if lighting failed to start
 * @param {string | null} o.unavailable  why lighting is null
 * @param {boolean} o.admin             the caller may change admin settings
 * @param {string} o.actor              "[label] " for the log
 * @param {(req: object) => Promise<any>} o.readBody
 * @param {(res: object, status: number, body: object) => void} o.sendJson
 * @param {{info: Function}} o.log      log.info(subject, msg)
 * @param {(key: string, line: string) => void} o.logGesture  one line per fader gesture
 * @param {(o: object) => Promise<object>} [o.companionImport]
 * @returns {Promise<boolean>} whether the route was handled
 */
export async function handleLighting({ req, res, path, lighting, unavailable, admin, actor, readBody, sendJson, log, logGesture, companionImport }) {
  if (path !== '/api/lighting' && !path.startsWith('/api/lighting/')) return false;
  if (!lighting) {
    sendJson(res, 503, { ok: false, error: `lighting is not running: ${unavailable ?? 'unknown error'}` });
    return true;
  }
  const method = req.method;
  let body;
  const input = async () => {
    try { return (await readBody(req)) ?? {}; } catch (err) {
      throw Object.assign(new Error(err instanceof SyntaxError ? 'the request body is not valid JSON' : err.message), { status: 400 });
    }
  };
  const reply = (r) => { sendJson(res, r.status, r.body); return true; };
  const audit = (r, line) => { if (r.ok) log.info('lighting', `${actor}${line}`); return reply(r); };
  let m;

  try {
    if (path === '/api/lighting' && method === 'GET') return reply({ status: 200, body: lighting.view({ full: true }) });

    if (path === '/api/lighting/frames' && method === 'GET') {
      return reply({ status: 200, body: { output: lighting.output.status(), frames: lighting.output.frames() } });
    }

    if (path === '/api/lighting/set' && method === 'POST') {
      body = await input();
      const r = lighting.set(body);
      if (r.ok) {
        // Each nudge is a press; an absolute set is usually one step of a drag.
        if (body.relative) log.info('lighting', `${actor}${describeSet(body)}`);
        else logGesture(JSON.stringify(body.target ?? {}), `${actor}${describeSet(body)}`);
      }
      return reply(r);
    }

    if ((m = path.match(SCENE))) {
      const slot = decodeURIComponent(m[1]);
      if (m[2] && method === 'POST') {
        body = await input();
        return audit(lighting.recallScene(slot, body), `scene ${slot} recalled${fadeText(body.fadeMs)}`);
      }
      if (!m[2] && method === 'PUT') {
        body = await input();
        const r = lighting.saveScene(slot, body);
        return audit(r, `scene ${slot} saved as "${r.body.scene?.name}"`);
      }
      if (!m[2] && method === 'PATCH') {
        body = await input();
        return audit(lighting.renameScene(slot, body.name), `scene ${slot} renamed "${body.name}"`);
      }
      if (!m[2] && method === 'DELETE') return audit(lighting.clearScene(slot), `scene ${slot} cleared`);
    }

    if ((m = path.match(LOOK)) && method === 'POST') {
      body = await input();
      const id = decodeURIComponent(m[1]);
      return audit(lighting.recallLook(id, body), `look "${id}" recalled${fadeText(body.fadeMs)}`);
    }

    if (path === '/api/lighting/output' && method === 'PUT') {
      body = await input();
      const r = lighting.setOutput(body, { admin });
      if (r.status === 403) log.info('lighting', `${actor}output change REFUSED (admin): ${JSON.stringify(body)}`);
      else if (r.ok) log.info('lighting', `${actor}output ${JSON.stringify(body)}`);
      return reply(r);
    }

    if (path === '/api/lighting/fixtures' && method === 'GET') {
      return reply({ status: 200, body: { fixtures: lighting.view().fixtures } });
    }
    if (path === '/api/lighting/fixtures' && method === 'POST') {
      body = await input();
      return audit(lighting.addFixture(body), `fixture added: ${JSON.stringify(body)}`);
    }
    if ((m = path.match(FIXTURE))) {
      const id = decodeURIComponent(m[1]);
      if (m[2] && method === 'POST') {
        body = await input();
        return audit(lighting.identify(id, body.ms), `identify ${id}`);
      }
      if (!m[2] && method === 'PUT') {
        body = await input();
        return audit(lighting.updateFixture(id, body), `fixture ${id} changed: ${JSON.stringify(body)}`);
      }
      if (!m[2] && method === 'DELETE') return audit(lighting.removeFixture(id), `fixture ${id} removed`);
    }

    if (path === '/api/lighting/profiles' && method === 'GET') {
      return reply({ status: 200, body: { profiles: lighting.view({ full: true }).profiles } });
    }
    if (path === '/api/lighting/profiles' && method === 'POST') {
      body = await input();
      return audit(lighting.addProfile(body), `profile ${body.id} added`);
    }
    if ((m = path.match(PROFILE))) {
      const id = decodeURIComponent(m[1]);
      if (method === 'PUT') {
        body = await input();
        return audit(lighting.updateProfile(id, body), `profile ${id} changed`);
      }
      if (method === 'DELETE') return audit(lighting.removeProfile(id), `profile ${id} removed`);
    }

    if (path === '/api/lighting/export' && method === 'GET') {
      res.setHeader('Content-Disposition', 'attachment; filename="cambridge-lighting.json"');
      return reply({ status: 200, body: lighting.exportConfig() });
    }
    if (path === '/api/lighting/import' && method === 'POST') {
      body = await input();
      const confirm = body.confirm === true;
      const r = lighting.importConfig(body.doc, { dryRun: !confirm, scenes: body.scenes !== false });
      return confirm ? audit(r, 'imported a lighting export') : reply(r);
    }
    if (path === '/api/lighting/import/companion' && method === 'POST' && companionImport) {
      body = await input();
      const r = await companionImport(body);
      return body.confirm === true ? audit(r, 'imported the scenes from Companion') : reply(r);
    }
  } catch (err) {
    if (err.status === 400) return reply({ status: 400, body: { ok: false, error: err.message } });
    throw err;
  }

  sendJson(res, 404, { ok: false, error: `no lighting route for ${method} ${path}` });
  return true;
}

function fadeText(ms) {
  return Number(ms) > 0 ? ` over ${Number(ms)} ms` : '';
}

function describeSet(b) {
  const t = b.target ?? {};
  const who = t.all ? 'all' : t.group !== undefined ? `group ${t.group}` : `fixture ${t.fixture}`;
  const bits = [];
  const sign = (v) => (b.relative && v >= 0 ? `+${v}` : `${v}`);
  if (b.intensity !== undefined) bits.push(`${sign(b.intensity)} %`);
  if (b.cct !== undefined) bits.push(`${sign(b.cct)} K`);
  return `lighting ${who} ${b.relative ? 'nudged ' : '→ '}${bits.join(', ')}${fadeText(b.fadeMs)}`;
}

/**
 * Logs the last line of a burst once it settles: a fader drag is many
 * commands but one decision, and the log is read for decisions.
 */
export function gestureLogger(write, quietMs = 400) {
  const pending = new Map();
  const fn = (key, line) => {
    const p = pending.get(key);
    if (p) clearTimeout(p.timer);
    const timer = setTimeout(() => { pending.delete(key); write(line); }, quietMs);
    timer.unref?.();
    pending.set(key, { timer, line });
  };
  fn.flush = () => {
    for (const [key, p] of pending) { clearTimeout(p.timer); pending.delete(key); write(p.line); }
  };
  return fn;
}
