#!/usr/bin/env node
/**
 * gen-real-scene-gf-strata.mjs — stratified ground-filter agreement on a real
 * scene (Track D of the real-scene validation program).
 *
 * The flat F1 in groundFilterProducerAgreement says the filter's precision
 * collapses in canopy but not WHERE. This bins the same confusion by RAW,
 * independent LAS fields — return number, and (where non-zero) intensity
 * quartile — so the failure can be read against a stratifier the filter never
 * sees. Slope is deliberately NOT used: it would come from a DTM the filter
 * itself produced, and the filter must not grade its own output.
 *
 * Exploratory: no accuracy floor. The committed oracle records per-bin
 * confusion; CI asserts the bins reconcile to the overall totals and each bin
 * has support. Producer labels are a REFERENCE, not survey truth.
 *
 *   SCENE=/path/tile.laz ID=OLV-DS-090 STRIDE=4 npx tsx scripts/gen-real-scene-gf-strata.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseLasHeader } from '../src/io/lasHeader.ts';
import { decodeLaz } from '../src/io/lazDecode.ts';
import { deriveClassification, DERIVED_GROUND } from '../src/render/class/deriveClassification.ts';

const SCENE = process.env.SCENE, ID = process.env.ID;
const STRIDE = Math.max(1, Math.floor(Number(process.env.STRIDE ?? '4')));
if (!SCENE || !ID) { console.error('SCENE and ID required'); process.exit(2); }
const PRODUCER_GROUND = 2;

const buf = readFileSync(SCENE);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const header = parseLasHeader(ab);
const out = await decodeLaz(buf, header, [header.min[0], header.min[1], header.min[2]], STRIDE);
const n = out.count ?? (out.positions.length / 3);
const codes = deriveClassification(out.positions, n, {}).codes;

function confusion(indices) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const i of indices) {
    const truth = out.classification[i] === PRODUCER_GROUND ? 1 : 0;
    const pred = codes[i] === DERIVED_GROUND ? 1 : 0;
    if (truth && pred) tp++; else if (!truth && pred) fp++; else if (truth && !pred) fn++; else tn++;
  }
  const recall = tp / Math.max(1, tp + fn), precision = tp / Math.max(1, tp + fp);
  const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
  return { support: indices.length, tp, fp, fn, tn, recall, precision, f1 };
}

const all = [...Array(n).keys()];
const overall = confusion(all);

// Return-number strata (1,2,3, then 4+ collapsed).
const rnBins = {};
for (let i = 0; i < n; i++) {
  const r = out.returnNumber ? out.returnNumber[i] : 1;
  const key = r >= 4 ? '4plus' : String(r);
  (rnBins[key] ??= []).push(i);
}
const byReturnNumber = {};
for (const k of Object.keys(rnBins).sort()) byReturnNumber[k] = confusion(rnBins[k]);

// Intensity quartiles, only when intensity is populated (Jemez is all-zero).
let byIntensityQuartile = null;
if (out.intensity) {
  const vals = Array.from(out.intensity.subarray(0, n));
  const nonzero = vals.filter((v) => v > 0).length;
  if (nonzero / n > 0.5) {
    const sorted = [...vals].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const cuts = [q(0.25), q(0.5), q(0.75)];
    const qb = { q1: [], q2: [], q3: [], q4: [] };
    for (let i = 0; i < n; i++) {
      const v = out.intensity[i];
      qb[v <= cuts[0] ? 'q1' : v <= cuts[1] ? 'q2' : v <= cuts[2] ? 'q3' : 'q4'].push(i);
    }
    byIntensityQuartile = { cuts };
    for (const k of ['q1', 'q2', 'q3', 'q4']) byIntensityQuartile[k] = confusion(qb[k]);
  }
}

const rec = { datasetId: ID, scene: SCENE.split('/').pop(), stride: STRIDE, sampledPoints: n,
  reference: 'producer-ground-class-2', overall, byReturnNumber, byIntensityQuartile };
const path = `validation/real-scene/gf-strata/${ID}.json`;
writeFileSync(path, JSON.stringify(rec, null, 2) + '\n');
console.log('wrote', path, '| overall F1', overall.f1.toFixed(3));
for (const [k, v] of Object.entries(byReturnNumber)) console.log(`  RN ${k}: prec ${v.precision.toFixed(3)} recall ${v.recall.toFixed(3)} support ${v.support}`);
if (byIntensityQuartile) for (const k of ['q1','q2','q3','q4']) console.log(`  I${k}: prec ${byIntensityQuartile[k].precision.toFixed(3)} support ${byIntensityQuartile[k].support}`);
