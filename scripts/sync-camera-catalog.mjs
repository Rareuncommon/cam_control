// One catalog drives the panel, API and Companion product list.
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('cambridge/src/camera-catalog.json', root)));
const path = new URL('companion-module-cambridge/companion/manifest.json', root);
const manifest = JSON.parse(readFileSync(path));
const products = catalog.models.map(p => p.model);
if (new Set(products).size !== products.length) throw new Error('Duplicate camera catalog model');
if (process.argv.includes('--write')) {
  manifest.products = products;
  manifest.description = 'Sony Camera Remote SDK camera control via CamBridge. Features depend on the connected body; expanded models await hardware validation.';
  writeFileSync(path, JSON.stringify(manifest, null, '\t') + '\n');
} else if (JSON.stringify(manifest.products) !== JSON.stringify(products)) {
  throw new Error('Companion camera list differs from the catalog. Run node scripts/sync-camera-catalog.mjs --write');
}
console.log(`Camera catalog: ${products.length} models, Companion list synchronized`);
