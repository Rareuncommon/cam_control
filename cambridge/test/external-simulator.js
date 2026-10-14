import { createServer } from 'node:http';
import { once } from 'node:events';
export async function blackmagicSimulator() {
  const state = { recording: false, iso: 400, writes: [], refuse: false, ignore: false, invalid: false };
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const path = req.url.replace('/control/api/v1', '');
    if (req.method !== 'GET') {
      state.writes.push({ path, method: req.method, body: body ? JSON.parse(body) : null });
      if (state.refuse) { res.writeHead(403); res.end(); return; }
      if (!state.ignore) { if (path === '/transports/0/record') state.recording = true; if (path === '/transports/0/stop') state.recording = false; if (path === '/video/iso') state.iso = JSON.parse(body).iso; }
      res.writeHead(204); res.end(); return;
    }
    const data = { '/system/product': { productName: 'Blackmagic PYXIS 6K' }, '/transports/0/record': { recording: state.recording }, '/video/iso': { iso: state.iso }, '/video/supportedISOs': { supportedISOs: [100, 200, 400, 800] } }[path];
    if (!data) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(state.invalid ? '<html>login</html>' : JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { state, port: server.address().port, close: () => new Promise(r => server.close(r)) };
}
export function usbConfig({ iso = '100', serial = 'SERIAL-A', bulb = false } = {}) {
  return `/main/status/serialnumber\nLabel: Serial Number\nReadonly: 1\nType: TEXT\nCurrent: ${serial}\n/main/imgsettings/iso\nLabel: ISO\nReadonly: 0\nType: RADIO\nCurrent: ${iso}\nChoice: 0 100\nChoice: 1 400\n/main/settings/capturetarget\nLabel: Capture target\nReadonly: 0\nType: RADIO\nCurrent: Memory card\nChoice: 0 Internal RAM\nChoice: 1 Memory card\n/main/capturesettings/shutterspeed\nLabel: Shutter\nReadonly: 1\nType: RADIO\nCurrent: ${bulb ? 'Bulb' : '1/50'}\nChoice: 0 Bulb\n/main/settings/format\nLabel: Format card\nReadonly: 0\nType: TOGGLE\nCurrent: 0\n`;
}
