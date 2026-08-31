#!/usr/bin/env node
/**
 * gen-real-scene-decode-stats.mjs — regenerate the decoder cross-implementation
 * oracle for one registered real scene (Track C of the real-scene validation).
 *
 * Decodes the tile through OLV's own LAZ path and through PDAL, and records both
 * sets of per-dimension statistics plus their delta. OLV decodes in the tile's
 * LOCAL frame (origin = header minimum) so its Float32 positions are sub-mm
 * faithful; absolute coordinates are local + origin. The committed oracle is
 * what CI reads — the cloud itself and PDAL are needed only to regenerate.
 *
 *   SCENE=/path/tile.laz ID=OLV-DS-090 npx tsx scripts/gen-real-scene-decode-stats.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { parseLasHeader } from '../src/io/lasHeader.ts';
import { decodeLaz } from '../src/io/lazDecode.ts';

const SCENE = process.env.SCENE;
const ID = process.env.ID;
if (!SCENE || !ID) { console.error('SCENE and ID required'); process.exit(2); }

const buf = readFileSync(SCENE);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const header = parseLasHeader(ab);
const origin = [header.min[0], header.min[1], header.min[2]];
const out = await decodeLaz(buf, header, origin, 1);
const n = out.count ?? (out.positions.length / 3);

// OLV absolute-frame stats
let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity,zsum=0;
const hist = {};
for (let i=0;i<n;i++){
  const x=out.positions[i*3]+origin[0], y=out.positions[i*3+1]+origin[1], z=out.positions[i*3+2]+origin[2];
  if(x<xmin)xmin=x; if(x>xmax)xmax=x; if(y<ymin)ymin=y; if(y>ymax)ymax=y;
  if(z<zmin)zmin=z; if(z>zmax)zmax=z; zsum+=z;
  const c=out.classification[i]; hist[c]=(hist[c]||0)+1;
}
const olv = { count:n, xmin, xmax, ymin, ymax, zmin, zmax, zmean: zsum/n, classHistogram: hist };

// PDAL reference
const pj = JSON.parse(execSync(`pdal info --stats ${JSON.stringify(SCENE)}`, {encoding:'utf8', maxBuffer:1<<28}));
const md = JSON.parse(execSync(`pdal info --metadata ${JSON.stringify(SCENE)}`, {encoding:'utf8', maxBuffer:1<<28})).metadata;
const by = {}; for (const s of pj.stats.statistic) by[s.name]=s;
const pdal = {
  count: by.X.count,
  xmin: by.X.minimum, xmax: by.X.maximum, ymin: by.Y.minimum, ymax: by.Y.maximum,
  zmin: by.Z.minimum, zmax: by.Z.maximum, zmean: by.Z.average,
  lasVersion: `${md.major_version}.${md.minor_version}`, pointFormat: md.dataformat_id,
  srs: (md.srs && md.srs.horizontal ? md.srs.horizontal : '').split('\n')[0].slice(0,120),
};
const delta = {
  count: olv.count - pdal.count,
  xmin: Math.abs(olv.xmin-pdal.xmin), xmax: Math.abs(olv.xmax-pdal.xmax),
  ymin: Math.abs(olv.ymin-pdal.ymin), ymax: Math.abs(olv.ymax-pdal.ymax),
  zmin: Math.abs(olv.zmin-pdal.zmin), zmax: Math.abs(olv.zmax-pdal.zmax),
  zmean: Math.abs(olv.zmean-pdal.zmean),
};
const rec = { datasetId: ID, scene: SCENE.split('/').pop(), reference: 'PDAL', olv, pdal, delta };
const path = `validation/real-scene/decode-stats/${ID}.json`;
writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
console.log('wrote', path);
console.log('count delta', delta.count, '| bounds max delta(m)', Math.max(delta.xmin,delta.xmax,delta.ymin,delta.ymax,delta.zmin,delta.zmax).toExponential(3), '| zmean delta', delta.zmean.toExponential(3));
console.log('LAS', pdal.lasVersion, 'fmt', pdal.pointFormat, '| srs', pdal.srs);
