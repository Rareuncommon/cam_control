import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CambridgeApi } from '../src/api.js';

test('Companion sends its configured token on commands, state reads and the event stream', async () => {
  const calls = [];
  const api = new CambridgeApi({ host: '127.0.0.1', port: 8088, token: 'test-only-token',
    log() {}, onState() {}, onConnection() {}, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/events')) return { ok: true, body: [] };
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    } });
  try {
    await api.request('GET', '/api/state');
    await api.request('POST', '/api/cameras/usb/actions/recordStart', {});
    api.start();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.options.headers.Authorization, 'Bearer test-only-token');
    assert.equal(calls[2].options.headers.Accept, 'text/event-stream');
  } finally { api.stop(); }
});
