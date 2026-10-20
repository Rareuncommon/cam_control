// One catalog drives the panel, API and Companion product list.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('cambridge/src/camera-catalog.json', root)));
const path = new URL('companion-module-cambridge/companion/manifest.json', root);
const manifest = JSON.parse(readFileSync(path));
// PTZ heads: the models CamBridge has a driver for (other models from the same
// makes are accepted too, but are not claimed here).
const { supported } = await import(new URL('cambridge/src/ptz/drivers/index.js', root).href);
const ptz = supported().flatMap((v) => v.models);
const external = JSON.parse(readFileSync(new URL('cambridge/src/external/catalog.json', root)));
if (new Set(external.models.map(p => p.id)).size !== external.models.length) throw new Error('Duplicate external profile id');
const models = [...new Set([...external.models.map(p => p.model), ...catalog.models.map(p => p.model), ...ptz])];
if (new Set(catalog.models.map(p => p.model)).size !== catalog.models.length) throw new Error('Duplicate SDK camera model');
// Companion joins every product into the connection's name and its Edit
// header, so listing all models buried the connection's own settings. Name
// the families instead; the full list is in the panel's Setup tab.
const products = [
  'Sony cinema and Alpha bodies (Camera Remote SDK)',
  'USB stills cameras (Canon, Nikon, Fujifilm and others)',
  'Blackmagic cinema and studio cameras',
  'PTZ cameras',
];
if (process.argv.includes('--write')) {
  manifest.products = products;
  manifest.description = 'Sony SDK, USB stills, Blackmagic cinema and PTZ camera control via CamBridge. Hardware validation remains model-specific.';
  manifest.manufacturer = 'Multiple';
  writeFileSync(path, JSON.stringify(manifest, null, '\t') + '\n');
} else if (JSON.stringify(manifest.products) !== JSON.stringify(products)) {
  throw new Error('Companion camera list differs from the catalog. Run node scripts/sync-camera-catalog.mjs --write');
}
console.log(`Camera catalog: ${models.length} models, Companion list synchronized`);
