#!/usr/bin/env node
/**
 * dem-package.mjs — `npm run dem:package -- <crop> <outdir>`.
 *
 * Builds the full DEM package for one committed terrain-field crop (the DTM,
 * DSM and CHM rasters, the evidence, sensitivity and attention rasters with
 * their QGIS styles, the README, the passport and SHA256SUMS), writes it under
 * <outdir>, and then runs the three independent Python readers against the
 * code rasters it wrote. It computes nothing itself. The builders are the
 * TypeScript modules the application and the tests use, reached through
 * tests/demPackageDriver.test.ts because Node cannot load extensionless
 * TypeScript imports; validation:matrix:update takes the same route.
 *
 * <crop> is a crop id under validation/terrain-field/crops (sl-field,
 * whitesands-dune, estonia-tava). <outdir> must be inside this repository, for
 * instance release/dem-package/sl-field: the readers refuse a directory outside
 * the tree they were asked to read, so a path elsewhere is rejected here before
 * anything is built. release/ is git-ignored.
 *
 * Exit 0 when the package was written and every reader's --check passed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [crop, outArg] = process.argv.slice(2);
if (!crop || !outArg) {
  console.error('usage: npm run dem:package -- <crop> <outdir>\n  crops: validation/terrain-field/crops/*.crop.json (sl-field, whitesands-dune, estonia-tava)');
  process.exit(2);
}
if (!existsSync(resolve(ROOT, 'validation/terrain-field/crops', `${crop}.crop.json`))) {
  console.error(`dem:package: no crop "${crop}" under validation/terrain-field/crops`);
  process.exit(2);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });
const rel = relative(realpathSync(ROOT), realpathSync(outDir));
if (rel.startsWith('..') || isAbsolute(rel)) {
  console.error(`dem:package: <outdir> must be inside the repository (the readers refuse to read elsewhere); got ${outDir}`);
  process.exit(2);
}

const NPX = requireBinaryOnPath('npx');
const PYTHON = requireBinaryOnPath('python3');

console.log(`── build the package for ${crop} into ${rel}`);
const build = spawnSync(NPX, ['vitest', 'run', 'tests/demPackageDriver.test.ts', '--reporter=dot'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, OLV_DEM_PACKAGE_CROP: crop, OLV_DEM_PACKAGE_OUT: outDir },
});
if (build.status !== 0) {
  console.error(`dem:package: the build failed (exit ${build.status})`);
  process.exit(build.status ?? 1);
}

// Each reader parses its raster byte by byte, recomputes what it can from the
// record beside it, and with --check also runs its negative control.
const READERS = [
  ['terrain-evidence', 'validation/terrain-evidence/oracle/evidence_geotiff.py'],
  ['terrain-attention', 'validation/terrain-attention/oracle/attention_geotiff.py'],
  ['terrain-sensitivity', 'validation/terrain-sensitivity/oracle/sensitivity_geotiff.py'],
];
let failed = 0;
for (const [name, reader] of READERS) {
  const dir = resolve(outDir, 'oracle', name);
  console.log(`── ${reader} --dir ${relative(ROOT, dir).split(sep).join('/')} --check`);
  const r = spawnSync(PYTHON, ['-I', resolve(ROOT, reader), '--dir', dir, '--check'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
if (failed > 0) {
  console.error(`dem:package: ${failed} reader(s) failed; the package is under ${rel} for inspection`);
  process.exit(1);
}
console.log(`dem:package OK — ${crop}: package and reader records under ${rel}; every reader agrees with the rasters.`);
