/**
 * The service worker's offline manifest for a built dist/: every
 * content-hashed bundle under assets/ with its byte size and SHA-256, plus the
 * total, and the SHA-256 of index.html. The worker stores a file only when its
 * digest matches, so a page and bundles from different deploys, or a host's
 * fallback page served in place of a bundle, are never saved.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HASHED = /-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|wasm|woff2?)$/i;

export function buildSwPrecacheManifest(dir) {
  const assets = readdirSync(join(dir, 'assets'))
    .filter((f) => HASHED.test(f))
    .sort()
    .map((f) => {
      const bytes = readFileSync(join(dir, 'assets', f));
      return { url: `./assets/${f}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
  const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
  const sha256 = createHash('sha256').update(readFileSync(join(dir, 'index.html'))).digest('hex');
  return { totalBytes, assets, index: { url: './index.html', sha256 } };
}
