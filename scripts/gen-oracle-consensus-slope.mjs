#!/usr/bin/env node
/**
 * gen-oracle-consensus-slope.mjs — regenerate the EXTERNAL legs of the slope
 * oracle-consensus record (validation/oracle-consensus/slope-horn.consensus.json).
 *
 * Needs GDAL (gdaldem, gdalinfo) and GRASS (grass) on PATH; NOT run in CI. It
 * writes a tilted-plane DEM whose Horn slope is atan(0.30) everywhere, runs
 * gdaldem slope -alg Horn and GRASS r.slope.aspect over the SAME grid and CRS
 * (the contract's matched configuration), and prints the mean interior slope of
 * each so the committed record can be updated by hand. OLV's own leg is NOT
 * produced here — the test recomputes it live so a code change is caught.
 *
 *   node scripts/gen-oracle-consensus-slope.mjs   # prints gdal + grass means
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const N = 50;
const G = 0.3;
const dir = mkdtempSync(join(tmpdir(), 'olv-slope-'));
const asc = join(dir, 'dem.asc');
let body = `ncols ${N}\nnrows ${N}\nxllcorner 0\nyllcorner 0\ncellsize 1\nNODATA_value -9999\n`;
for (let r = 0; r < N; r++) body += Array.from({ length: N }, (_, c) => (G * c).toFixed(6)).join(' ') + '\n';
writeFileSync(asc, body);

const gdalTif = join(dir, 'slope.tif');
execFileSync('/usr/bin/env', ['gdaldem', 'slope', asc, gdalTif, '-alg', 'Horn', '-of', 'GTiff']);
const info = execFileSync('/usr/bin/env', ['gdalinfo', '-stats', gdalTif], { encoding: 'utf8' });
const gdalMean = Number(/STATISTICS_MEAN=([0-9.]+)/.exec(info)?.[1]);

const grassOut = execFileSync(
  '/usr/bin/env',
  ['grass', '-c', 'EPSG:32633', join(dir, 'loc'), '--exec', 'bash', '-c',
    `r.in.gdal -o input=${asc} output=dem --overwrite >/dev/null 2>&1; g.region raster=dem >/dev/null 2>&1; ` +
    `r.slope.aspect elevation=dem slope=slp --overwrite >/dev/null 2>&1; r.univar -g map=slp 2>/dev/null | grep '^mean='`],
  { encoding: 'utf8' },
);
const grassMean = Number(/mean=([0-9.]+)/.exec(grassOut)?.[1]);

const analytic = (Math.atan(G) * 180) / Math.PI;
console.log(`analytic mean slope deg = ${analytic}`);
console.log(`gdal-horn-slope   meanSlopeDeg = ${gdalMean}`);
console.log(`grass-horn-slope  meanSlopeDeg = ${grassMean}`);
console.log('Update validation/oracle-consensus/slope-horn.consensus.json with these + the tool versions.');
