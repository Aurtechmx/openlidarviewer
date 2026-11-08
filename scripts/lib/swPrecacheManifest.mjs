/**
 * The service worker's offline manifest for a built dist/: every
 * content-hashed bundle under assets/ with its byte size, plus the total, and
 * the SHA-256 of index.html. The worker saves an index.html only when its
 * digest matches, so a page and a manifest from different deploys are never
 * stored together.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HASHED = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|wasm|woff2?)$/i;

export function buildSwPrecacheManifest(dir) {
  const assets = readdirSync(join(dir, 'assets'))
    .filter((f) => HASHED.test(f))
    .sort()
    .map((f) => ({ url: `./assets/${f}`, bytes: statSync(join(dir, 'assets', f)).size }));
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  const sha256 = createHash('sha256').update(readFileSync(join(dir, 'index.html'))).digest('hex');
  return { totalBytes, assets, index: { url: './index.html', sha256 } };
}
