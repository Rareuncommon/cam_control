// Import only the filtered metadata emitted by list-gphoto-control-models.c.
import { readFileSync, writeFileSync } from 'node:fs';
const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n');
const version = lines.shift().match(/^# libgphoto2 (\d+\.\d+\.\d+)$/)?.[1];
if (!version) throw new Error('Expected libgphoto2 version header');
const path = new URL('../cambridge/src/external/catalog.json', import.meta.url);
const catalog = JSON.parse(readFileSync(path));
const brands = new Set(['Canon', 'Nikon', 'Fuji', 'Olympus', 'OM', 'Panasonic', 'Pentax', 'Ricoh', 'Sigma', 'Leica', 'Hasselblad']);
const usb = lines.filter(model => brands.has(model.split(' ')[0])).map(model => ({
  id: 'usb-' + model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
  brand: model.startsWith('Fuji ') ? 'Fujifilm' : model.split(' ')[0], model, provider: 'gphoto2',
  source: `https://github.com/gphoto/libgphoto2/releases/tag/v${version}`,
  verification: `libgphoto2-${version}-production-driver-capture-and-config; hardware-validation-pending`,
}));
if (!usb.length || new Set(usb.map(m => m.id)).size !== usb.length) throw new Error('Empty or duplicate USB catalog');
catalog.models = [...catalog.models.filter(m => m.provider !== 'gphoto2'), ...usb].sort((a,b) => a.model < b.model ? -1 : a.model > b.model ? 1 : 0);
writeFileSync(path, JSON.stringify(catalog, null, 2) + '\n');
console.log(`Imported ${usb.length} USB profiles from libgphoto2 ${version}; regional aliases remain explicit`);
