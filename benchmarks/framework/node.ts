/**
 * node.ts
 *
 * The Node-only entry point. Everything here needs a filesystem, a subprocess or
 * `node:crypto`; everything in `index.ts` runs in either runtime.
 *
 * The split is load-bearing, not tidiness. Re-exporting `captureEnvironment`
 * from the barrel made `node:child_process` and friends static dependencies of
 * the WHOLE surface, so a browser-side suite — the schema advertises
 * browser-taken metrics, and `clock.ts`/`memory.ts` both have browser branches —
 * could not import the framework at all once Vite tried to bundle it. A suite
 * imports from `index.ts` for the schema and the reporters, and additionally
 * from here when it is running under Node.
 */

export { captureEnvironment } from './env';
export type { CaptureEnvironmentOptions } from './env';

import { createHash } from 'node:crypto';
import { sha256Hex } from '../../src/terrain/export/sha256';
import { hashArtifact, type HashArtifactOptions } from './artifacts';
import type { ArtifactRecord } from './types';

/**
 * SHA-256 through `node:crypto`, falling back to the portable implementation.
 *
 * Same digest, bit for bit — this is a throughput fix, not a correctness one, so
 * a hash produced on either path is comparable with the other. The portable
 * implementation runs at ~40 MiB/s and copies the payload into a padded buffer,
 * which on a 500 MB raster is roughly twelve seconds and half a gigabyte of
 * transient memory charged to whichever stage happens to be timing it.
 *
 * The fallback exists because this file may be loaded in an environment where
 * `node:crypto` is stubbed; a slower correct answer beats a thrown one.
 */
export function nodeSha256Hex(bytes: Uint8Array): string {
  try {
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return sha256Hex(bytes);
  }
}

/** `hashArtifact` with the fast digest already wired in. */
export function hashArtifactNode(
  name: string,
  value: unknown,
  options: HashArtifactOptions = {},
): ArtifactRecord {
  return hashArtifact(name, value, { digest: nodeSha256Hex, ...options });
}
