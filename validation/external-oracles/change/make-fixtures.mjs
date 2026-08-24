#!/usr/bin/env node
/**
 * make-fixtures.mjs — build the frozen epoch pairs for the change study.
 *
 * One generator emits both sides: the JSON the candidate reads and the ASCII
 * grids GRASS reads. Writing them from a single source is what makes the two
 * legs the same experiment; two hand-maintained copies drift and the drift
 * shows up as a disagreement that is really a typo.
 *
 * Every case carries `truth`, the closed-form gain and loss volume computed
 * from the construction rather than from either implementation. Truth outranks
 * agreement: two programs summing the same wrong cells agree perfectly.
 *
 * Usage:  node validation/external-oracles/change/make-fixtures.mjs
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));

/** The level of detection every case is scored at. Below it, nothing counts. */
const LOD_M = 0.05;
/** One metre cells throughout, so cell area is 1 m² and volumes read directly. */
const CELL_M = 1;

const grid = (w, h, fn) => {
  const v = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v[y * w + x] = fn(x, y);
  return { width: w, height: h, values: Array.from(v) };
};

/** A box region helper: inclusive lower, exclusive upper. */
const inBox = (x, y, x0, x1, y0, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;

const cases = [];

// 1. Uniform lift over the whole grid. Volume is area times offset, exactly.
{
  const w = 20, h = 20, dz = 0.5;
  cases.push({
    id: 'C01-uniform-lift',
    why: 'Every cell moves by the same amount, so gain volume is area times offset with no thresholding subtlety.',
    a: grid(w, h, () => 100),
    b: grid(w, h, () => 100 + dz),
    truth: { gainVolumeM3: w * h * dz * CELL_M * CELL_M, lossVolumeM3: 0, gainedCells: w * h, lostCells: 0 },
  });
}

// 2. A single raised block. The classic cut-volume case.
{
  const w = 20, h = 20, dz = 2, x0 = 5, x1 = 10, y0 = 5, y1 = 9;
  const n = (x1 - x0) * (y1 - y0);
  cases.push({
    id: 'C02-block-uplift',
    why: 'A localized rectangular gain against flat ground: known cell count times known height.',
    a: grid(w, h, () => 50),
    b: grid(w, h, (x, y) => (inBox(x, y, x0, x1, y0, y1) ? 50 + dz : 50)),
    truth: { gainVolumeM3: n * dz, lossVolumeM3: 0, gainedCells: n, lostCells: 0 },
  });
}

// 3. A single excavated block, the sign mirror of case 2.
{
  const w = 20, h = 20, dz = 1.5, x0 = 12, x1 = 17, y0 = 3, y1 = 8;
  const n = (x1 - x0) * (y1 - y0);
  cases.push({
    id: 'C03-block-excavation',
    why: 'The mirror of C02. A sign error that survives a gain-only case fails here.',
    a: grid(w, h, () => 50),
    b: grid(w, h, (x, y) => (inBox(x, y, x0, x1, y0, y1) ? 50 - dz : 50)),
    truth: { gainVolumeM3: 0, lossVolumeM3: n * dz, gainedCells: 0, lostCells: n },
  });
}

// 4. Cut and fill that nearly cancel. Net near zero, gross large.
{
  const w = 24, h = 24, up = 1.2, down = 1.2;
  const nUp = 6 * 6, nDown = 6 * 6;
  cases.push({
    id: 'C04-cut-fill-net-zero',
    why: 'Net volume near zero while gross gain and loss are both large. An implementation reporting only net looks correct here and is not.',
    a: grid(w, h, () => 200),
    b: grid(w, h, (x, y) => {
      if (inBox(x, y, 2, 8, 2, 8)) return 200 + up;
      if (inBox(x, y, 14, 20, 14, 20)) return 200 - down;
      return 200;
    }),
    truth: { gainVolumeM3: nUp * up, lossVolumeM3: nDown * down, gainedCells: nUp, lostCells: nDown },
  });
}

// 5. Displacement below the level of detection. Nothing may count.
{
  const w = 16, h = 16, dz = 0.04; // strictly under LOD_M
  cases.push({
    id: 'C05-sub-lod',
    why: 'A real but sub-threshold shift. The level of detection exists to keep this out of the volume, so the correct answer is zero, not a small number.',
    a: grid(w, h, () => 10),
    b: grid(w, h, () => 10 + dz),
    truth: { gainVolumeM3: 0, lossVolumeM3: 0, gainedCells: 0, lostCells: 0 },
  });
}

// 6. Just above the level of detection. The other side of the same edge.
{
  const w = 16, h = 16, dz = 0.06; // strictly over LOD_M
  cases.push({
    id: 'C06-just-above-lod',
    why: 'One centimetre the other side of C05. A threshold written as >= rather than > moves both cases, and only a pair catches it.',
    a: grid(w, h, () => 10),
    b: grid(w, h, () => 10 + dz),
    truth: { gainVolumeM3: w * h * dz, lossVolumeM3: 0, gainedCells: w * h, lostCells: 0 },
  });
}

// 7. Holes in one epoch. A cell missing on either side is not comparable.
{
  const w = 18, h = 18, dz = 1;
  const holes = new Set(['0,0', '5,5', '5,6', '17,17', '9,9']);
  const raised = (x, y) => inBox(x, y, 4, 10, 4, 10);
  // A hole inside the raised block removes that cell from the gain volume.
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (raised(x, y) && !holes.has(`${x},${y}`)) n += 1;
  }
  cases.push({
    id: 'C07-holes',
    why: 'Missing cells fall inside the changed block, so a run that treats absent as zero over-counts the volume rather than merely losing coverage.',
    a: grid(w, h, () => 30),
    b: grid(w, h, (x, y) => (holes.has(`${x},${y}`) ? Number.NaN : raised(x, y) ? 30 + dz : 30)),
    truth: { gainVolumeM3: n * dz, lossVolumeM3: 0, gainedCells: n, lostCells: 0 },
  });
}

// 8. A ramp, so the change varies per cell instead of being piecewise constant.
{
  const w = 20, h = 20;
  // b - a = 0.1 * x, so cells x=0 (0.0) and the sub-LoD x=0 are excluded.
  let gain = 0, cells = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = 0.1 * x;
    if (d > LOD_M) { gain += d; cells += 1; }
  }
  cases.push({
    id: 'C08-ramp',
    why: 'A per-cell varying difference rather than a constant block, so the volume is a real sum and not one multiplication.',
    a: grid(w, h, () => 0),
    b: grid(w, h, (x) => 0.1 * x),
    truth: { gainVolumeM3: gain, lossVolumeM3: 0, gainedCells: cells, lostCells: 0 },
  });
}

/** ESRI ASCII, with `*` for the no-data cells GRASS reads as null. */
function toAsc(g) {
  const head =
    `north: ${g.height}\nsouth: 0\neast: ${g.width}\nwest: 0\n` +
    `rows: ${g.height}\ncols: ${g.width}\n`;
  const rows = [];
  for (let y = 0; y < g.height; y++) {
    const row = [];
    for (let x = 0; x < g.width; x++) {
      const v = g.values[y * g.width + x];
      row.push(Number.isFinite(v) ? v.toFixed(6) : '*');
    }
    rows.push(row.join(' '));
  }
  return `${head}${rows.join('\n')}\n`;
}

mkdirSync(resolve(HERE, 'grids'), { recursive: true });
for (const c of cases) {
  writeFileSync(resolve(HERE, `grids/${c.id}__a.asc`), toAsc(c.a));
  writeFileSync(resolve(HERE, `grids/${c.id}__b.asc`), toAsc(c.b));
}

const payload = {
  schemaVersion: 1,
  levelOfDetectionM: LOD_M,
  cellSizeM: CELL_M,
  note: 'Values are exact decimal literals. `null` marks a cell absent from that epoch; GRASS reads the matching `*` in the ASCII grids as null and OLV reads null as NaN.',
  cases: cases.map((c) => ({
    id: c.id,
    why: c.why,
    width: c.a.width,
    height: c.a.height,
    truth: c.truth,
    a: c.a.values.map((v) => (Number.isFinite(v) ? v : null)),
    b: c.b.values.map((v) => (Number.isFinite(v) ? v : null)),
  })),
};

const json = `${JSON.stringify(payload, null, 2)}\n`;
writeFileSync(resolve(HERE, 'fixtures.json'), json);

console.log(
  `make-fixtures: ${cases.length} case(s), sha256:${createHash('sha256').update(json).digest('hex').slice(0, 16)}…\n` +
    cases.map((c) => `  ${c.id.padEnd(24)} gain ${c.truth.gainVolumeM3.toFixed(2)} m3, loss ${c.truth.lossVolumeM3.toFixed(2)} m3`).join('\n'),
);
