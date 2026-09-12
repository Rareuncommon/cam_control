// One catalog drives the panel, API and Companion product list.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('cambridge/src/camera-catalog.json', root)));
const path = new URL('companion-module-cambridge/companion/manifest.json', root);
const manifest = JSON.parse(readFileSync(path));
const ptz = JSON.parse(readFileSync(new URL('cambridge/src/ptz/catalog.json', root)));
const products = [...new Set([...catalog.models.map(p => p.model), ...ptz.profiles.filter(p => p.brand !== 'Generic').map(p => p.model)])];
if (new Set(ptz.profiles.map(p => p.id)).size !== ptz.profiles.length) throw new Error('Duplicate PTZ profile id');
if (new Set(catalog.models.map(p => p.model)).size !== catalog.models.length) throw new Error('Duplicate SDK camera model');
if (process.argv.includes('--write')) {
  manifest.products = products;
  manifest.description = 'Sony SDK camera control and multi-brand network PTZ movement via CamBridge. Hardware validation remains model-specific.';
  manifest.manufacturer = 'Multiple';
  writeFileSync(path, JSON.stringify(manifest, null, '\t') + '\n');
} else if (JSON.stringify(manifest.products) !== JSON.stringify(products)) {
  throw new Error('Companion camera list differs from the catalog. Run node scripts/sync-camera-catalog.mjs --write');
}
console.log(`Camera catalog: ${products.length} models, Companion list synchronized`);
