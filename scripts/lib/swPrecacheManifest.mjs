/**
 * The service worker's offline manifest for a built dist/: every
 * content-hashed bundle under assets/ with its byte size, plus the total.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HASHED = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|wasm|woff2?)$/i;

export function buildSwPrecacheManifest(dir) {
  const assets = readdirSync(join(dir, 'assets'))
    .filter((f) => HASHED.test(f))
    .sort()
    .map((f) => ({ url: `./assets/${f}`, bytes: statSync(join(dir, 'assets', f)).size }));
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  return { totalBytes, assets };
}
