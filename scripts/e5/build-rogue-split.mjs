#!/usr/bin/env node
/**
 * build-rogue-split.mjs — deterministic, exposure-honest dev/holdout split of the
 * 25 Rogue tiles for retrospective E5 hardening.
 *
 * Rogue is a RETROSPECTIVE development set; it never becomes E5. To keep a
 * holdout honest, any tile the repository had already used before the split was
 * frozen (register, tests, committed metrics) is EXPOSED and forced into
 * development — it cannot serve as an untouched holdout. The exposed set is
 * pinned in an immutable ledger (validation/e5/splits/ROGUE25.exposure.json) and
 * read from there, not rediscovered by a live git scan: a later doc that mentions
 * a tile must not silently move it out of the holdout, and the split must
 * reproduce byte-for-byte on any machine. The remaining unexposed tiles are split
 * by a fixed rule: order by sha256("ROGUE-E5-HARDENING-v1" + fileSha256), fill
 * development to the target, the rest are holdout. Ordering is by UTF-16 code unit
 * (localeCompare's ICU collation differs across machines), so the split depends
 * only on file content, a constant salt and the pinned ledger.
 *
 * Usage: node scripts/e5/build-rogue-split.mjs <ROGUE25.input.json> <out.split.json> [exposure-ledger.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';

const [, , inPath, outPath, exposurePathArg] = process.argv;
if (!inPath || !outPath) {
  console.error('usage: build-rogue-split.mjs <input-manifest> <out.split.json> [exposure-ledger.json]');
  process.exit(2);
}
const SALT = 'ROGUE-E5-HARDENING-v1';
const TARGET_DEV = 17;
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..', '..');
const EXPOSURE_PATH = exposurePathArg
  ? resolve(exposurePathArg)
  : resolve(ROOT, 'validation/e5/splits/ROGUE25.exposure.json');

// Order by raw string code unit, never localeCompare: ICU collation varies by
// machine/locale and would make the hashed ordering non-reproducible.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const manifest = JSON.parse(readFileSync(resolve(inPath), 'utf8'));
const tileId = (basename) => (basename.match(/10T[A-Z]{2}\d+/) ?? [basename])[0];

// Exposure comes only from the immutable ledger. Its raw bytes are hashed into
// exposureDigest, and its collectionDigest must match the manifest it was pinned
// against, so a ledger paired with the wrong input fails loudly.
const exposureText = readFileSync(EXPOSURE_PATH, 'utf8');
const exposure = JSON.parse(exposureText);
if (exposure.collectionDigest !== manifest.collectionDigest) {
  console.error(
    `exposure ledger collectionDigest ${exposure.collectionDigest} does not match manifest ${manifest.collectionDigest}`,
  );
  process.exit(3);
}
const exposedIds = new Set((exposure.exposed ?? []).map((e) => e.tileId));
const exposureDigest = createHash('sha256').update(exposureText).digest('hex');

const tiles = manifest.tiles.map((t) => {
  const id = tileId(t.basename);
  return {
    tileId: id,
    basename: t.basename,
    sha256: t.sha256,
    exposed: exposedIds.has(id),
    orderKey: createHash('sha256').update(SALT + t.sha256).digest('hex'),
  };
});

const exposed = tiles.filter((t) => t.exposed);
const unexposed = tiles.filter((t) => !t.exposed).sort((a, b) => byCodeUnit(a.orderKey, b.orderKey));

const devFromUnexposed = Math.max(0, TARGET_DEV - exposed.length);
const assign = (t, set) => ({ tileId: t.tileId, basename: t.basename, sha256: t.sha256, exposed: t.exposed, set });
const assigned = [
  ...exposed.map((t) => assign(t, 'development')), // exposed → forced development
  ...unexposed.slice(0, devFromUnexposed).map((t) => assign(t, 'development')),
  ...unexposed.slice(devFromUnexposed).map((t) => assign(t, 'holdout')),
].sort((a, b) => byCodeUnit(a.tileId, b.tileId));

const dev = assigned.filter((t) => t.set === 'development');
const holdout = assigned.filter((t) => t.set === 'holdout');
// splitDigest folds in exposureDigest so the recorded split is bound to the exact
// exposure set it was built from, not just the membership labels.
const splitDigest = createHash('sha256')
  .update(`${exposureDigest}\n${assigned.map((t) => `${t.tileId}:${t.set}`).join('\n')}`)
  .digest('hex');

const out = {
  $schemaNote:
    'Deterministic exposure-honest dev/holdout split of the 25 Rogue tiles for RETROSPECTIVE E5 hardening. Rogue never becomes E5. Exposed tiles are pinned in the immutable ROGUE25.exposure.json ledger and forced into development; unexposed tiles are ordered by sha256(salt + fileSha256) compared by code unit and filled to the development target, the rest holdout. Reproducible from the input manifest and the exposure ledger alone.',
  policy: {
    salt: SALT,
    targetDevelopment: TARGET_DEV,
    exposureLedger: 'validation/e5/splits/ROGUE25.exposure.json',
    ordering: 'UTF-16 code unit on sha256(salt+fileSha256); no locale collation',
    rule: 'exposed → development; unexposed ordered by sha256(salt+fileSha256), first (target − exposed) → development, rest → holdout',
  },
  inputCollectionDigest: manifest.collectionDigest,
  exposureDigest,
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
