#!/usr/bin/env node
/**
 * build-rogue-split.mjs — deterministic, exposure-honest dev/holdout split of the
 * 25 Rogue tiles for retrospective E5 hardening.
 *
 * Rogue is a RETROSPECTIVE development set; it never becomes E5. To keep a
 * holdout honest, any tile the repository has already used (register, tests,
 * committed metrics) is EXPOSED and forced into development — it cannot serve as
 * an untouched holdout. The remaining unexposed tiles are split by a fixed rule:
 * order by sha256("ROGUE-E5-HARDENING-v1" + fileSha256), fill development to the
 * target, the rest are holdout. The ordering depends only on file content and a
 * constant salt, so the split is reproducible and independent of tile id or
 * order in the manifest.
 *
 * Usage: node scripts/e5/build-rogue-split.mjs <ROGUE25.input.json> <out.split.json>
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: build-rogue-split.mjs <input-manifest> <out.split.json>');
  process.exit(2);
}
const SALT = 'ROGUE-E5-HARDENING-v1';
const TARGET_DEV = 17;
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');

const manifest = JSON.parse(readFileSync(resolve(inPath), 'utf8'));
const tileId = (basename) => (basename.match(/10T[A-Z]{2}\d+/) ?? [basename])[0];

/** Every tracked file (git ls-files), so exposure detection is over the repo. */
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, maxBuffer: 32 << 20 })
  .toString()
  .split('\n')
  .filter(Boolean)
  // A tile id appearing only in the E5 input/split manifests is not "use".
  .filter((f) => !/validation\/e5\/manifests\/(ROGUE25|HOUSTON17)\.input\.json$/.test(f))
  .filter((f) => !f.endsWith('ROGUE25.split.json'));

/** Is this tile id referenced by any tracked file other than the manifests? */
function isExposed(id) {
  try {
    execFileSync('git', ['grep', '-l', id, '--', ...tracked], { cwd: ROOT, maxBuffer: 32 << 20 });
    return true;
  } catch {
    return false; // git grep exits non-zero when there is no match
  }
}

const tiles = manifest.tiles.map((t) => {
  const id = tileId(t.basename);
  return {
    tileId: id,
    basename: t.basename,
    sha256: t.sha256,
    exposed: isExposed(id),
    orderKey: createHash('sha256').update(SALT + t.sha256).digest('hex'),
  };
});

const exposed = tiles.filter((t) => t.exposed);
const unexposed = tiles.filter((t) => !t.exposed).sort((a, b) => a.orderKey.localeCompare(b.orderKey));

const devFromUnexposed = Math.max(0, TARGET_DEV - exposed.length);
const assign = (t, set) => ({ tileId: t.tileId, basename: t.basename, sha256: t.sha256, exposed: t.exposed, set });
const assigned = [
  ...exposed.map((t) => assign(t, 'development')), // exposed → forced development
  ...unexposed.slice(0, devFromUnexposed).map((t) => assign(t, 'development')),
  ...unexposed.slice(devFromUnexposed).map((t) => assign(t, 'holdout')),
].sort((a, b) => a.tileId.localeCompare(b.tileId));

const dev = assigned.filter((t) => t.set === 'development');
const holdout = assigned.filter((t) => t.set === 'holdout');
const splitDigest = createHash('sha256')
  .update(assigned.map((t) => `${t.tileId}:${t.set}`).join('\n'))
  .digest('hex');

const out = {
  $schemaNote:
    'Deterministic exposure-honest dev/holdout split of the 25 Rogue tiles for RETROSPECTIVE E5 hardening. Rogue never becomes E5. Exposed tiles (already used anywhere in the repo) are forced into development; unexposed tiles are ordered by sha256(salt + fileSha256) and filled to the development target, the rest holdout. Reproducible from the input manifest alone.',
  policy: {
    salt: SALT,
    targetDevelopment: TARGET_DEV,
    rule: 'exposed → development; unexposed ordered by sha256(salt+fileSha256), first (target − exposed) → development, rest → holdout',
  },
  inputCollectionDigest: manifest.collectionDigest,
  splitDigest,
  summary: {
    total: assigned.length,
    development: dev.length,
    holdout: holdout.length,
    exposedForcedToDevelopment: exposed.map((t) => t.tileId),
  },
  tiles: assigned,
};
writeFileSync(resolve(outPath), JSON.stringify(out, null, 2) + '\n');
console.error(
  `→ ${outPath}: ${dev.length} development / ${holdout.length} holdout, ${exposed.length} exposed forced to dev, splitDigest ${splitDigest.slice(0, 12)}…`,
);
