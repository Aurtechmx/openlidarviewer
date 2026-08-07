/**
 * Synthetic evaluation of the building ground-support gate (PR #277).
 *
 * Builds a labeled corpus of synthetic scenes at cellSizeM = 1.0 and runs
 * deriveClassification twice on the SAME points: once with the gate disabled
 * (buildingMinSupport = 0, "before #277") and once with the default gate
 * (buildingMinSupport = 0.66, "after #277"). It then reports the BUILDING-class
 * confusion matrix against ground truth for each setting.
 *
 * Run: npx tsx scripts/eval-building-gate.ts
 */

import {
  deriveClassification,
  DERIVED_BUILDING,
  DERIVED_UNCLASSIFIED,
} from '../src/render/class/deriveClassification';

type Cat = 'real' | 'artifact' | 'veg' | 'ground';

interface PtBuf {
  xs: number[];
  ys: number[];
  zs: number[];
  r: number[];
  g: number[];
  b: number[];
  rn: number[]; // return number
  rc: number[]; // return count
  truth: boolean[]; // isBuilding
  cat: Cat[];
}

function makeBuf(): PtBuf {
  return { xs: [], ys: [], zs: [], r: [], g: [], b: [], rn: [], rc: [], truth: [], cat: [] };
}

function push(
  buf: PtBuf,
  x: number,
  y: number,
  z: number,
  rgb: [number, number, number],
  rn: number,
  rc: number,
  truth: boolean,
  cat: Cat,
): void {
  buf.xs.push(x);
  buf.ys.push(y);
  buf.zs.push(z);
  buf.r.push(rgb[0]);
  buf.g.push(rgb[1]);
  buf.b.push(rgb[2]);
  buf.rn.push(rn);
  buf.rc.push(rc);
  buf.truth.push(truth);
  buf.cat.push(cat);
}

const GRAY: [number, number, number] = [140, 140, 140];
const GREEN: [number, number, number] = [40, 170, 40];

// A solid measured ground lattice covering [x0,x1]x[y0,y1] at ~0.4 m spacing so
// every cell in the region sees points (support 1.0 for anything inside).
function groundLattice(buf: PtBuf, x0: number, x1: number, y0: number, y1: number): void {
  const step = 0.4;
  for (let x = x0; x <= x1 + 1e-9; x += step) {
    for (let y = y0; y <= y1 + 1e-9; y += step) {
      push(buf, x, y, 0.0, GRAY, 1, 1, false, 'ground');
    }
  }
}

// A flat planar roof patch at z=H, dense (0.25 m spacing) so the neighbourhood
// has enough points to read as planar.
function roofPatch(
  buf: PtBuf,
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  z: number,
  truth: boolean,
): void {
  const step = 0.25;
  for (let x = cx - halfW; x <= cx + halfW + 1e-9; x += step) {
    for (let y = cy - halfH; y <= cy + halfH + 1e-9; y += step) {
      push(buf, x, y, z, GRAY, 1, 1, truth, truth ? 'real' : 'artifact');
    }
  }
}

function main(): void {
  const buf = makeBuf();

  // Anchor the grid origin. cellSizeM = 1.0 makes cell boundaries fall on
  // integer x/y, so a strip centred on an integer+0.5 sits inside ONE cell
  // column. A single isolated gray ground point at (0,0,0) is the global
  // minimum in x and y, fixing minX = minY = 0 for the whole corpus.
  push(buf, 0, 0, 0.0, GRAY, 1, 1, false, 'ground');

  // --- Category 1: real buildings (truth = building) ---
  // Roof at z=5 embedded in a solid ground lattice, so support = 1.0.
  const REAL_N = 6;
  for (let k = 0; k < REAL_N; k++) {
    const cx = 20 + k * 30;
    const cy = 20;
    // ground lattice a good margin larger than the roof
    groundLattice(buf, cx - 6, cx + 6, cy - 6, cy + 6);
    roofPatch(buf, cx, cy, 2.5, 2.5, 5.0, true);
  }

  // --- Category 2: scan-edge artifact "roofs" (truth = non-building) ---
  // A thin scan-edge roof column: a strip one cell wide holding BOTH ground
  // (z=0, so the local grid-minimum is real and the roof HAG is a true 5 m) and
  // a flat roof (z=5). The neighbouring cell columns are empty void, so the
  // roof points' bilinear footprint reaches 2 measured + 2 unmeasured corners
  // => support = 0.5 exactly. The centre sits at integer+0.5 so the 0.6 m wide
  // strip stays inside one column (minX = 0 from the anchor point).
  const ART_N = 8;
  for (let k = 0; k < ART_N; k++) {
    const cx = 15.5 + k * 20; // cell-centred -> single measured column
    const cy = 200.5; // far from any ground region; a void all around
    const stepY = 0.25;
    for (let y = cy - 4; y <= cy + 4 + 1e-9; y += stepY) {
      // ground floor of the strip (true bare earth -> low grid minimum)
      push(buf, cx, y, 0.0, GRAY, 1, 1, false, 'ground');
      // roof of the strip (the low-support "roof" #277 targets)
      push(buf, cx - 0.15, y, 5.0, GRAY, 1, 1, false, 'artifact');
      push(buf, cx + 0.15, y, 5.0, GRAY, 1, 1, false, 'artifact');
    }
  }

  // --- Category 3: vegetation controls (truth = non-building) ---
  // Tall green multi-return patches over solid ground: must never be building.
  const VEG_N = 4;
  for (let k = 0; k < VEG_N; k++) {
    const cx = 20 + k * 30;
    const cy = 120;
    groundLattice(buf, cx - 6, cx + 6, cy - 6, cy + 6);
    const step = 0.25;
    for (let x = cx - 2.5; x <= cx + 2.5 + 1e-9; x += step) {
      for (let y = cy - 2.5; y <= cy + 2.5 + 1e-9; y += step) {
        // green AND multi-return (returnCount = 2)
        push(buf, x, y, 5.0, GREEN, 1, 2, false, 'veg');
      }
    }
  }

  // --- Category 4: ground controls (truth = non-building) ---
  // Flat low points near z=0 over their own lattice.
  const GND_N = 4;
  for (let k = 0; k < GND_N; k++) {
    const cx = 20 + k * 30;
    const cy = 60;
    groundLattice(buf, cx - 4, cx + 4, cy - 4, cy + 4);
  }

  const count = buf.xs.length;
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  const returnNumber = new Uint8Array(count);
  const returnCount = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = buf.xs[i];
    positions[i * 3 + 1] = buf.ys[i];
    positions[i * 3 + 2] = buf.zs[i];
    colors[i * 3] = buf.r[i];
    colors[i * 3 + 1] = buf.g[i];
    colors[i * 3 + 2] = buf.b[i];
    returnNumber[i] = buf.rn[i];
    returnCount[i] = buf.rc[i];
  }

  const baseOpts = {
    cellSizeM: 1.0,
    colors,
    returnNumber,
    returnCount,
  } as const;

  const before = deriveClassification(positions, count, { ...baseOpts, buildingMinSupport: 0 });
  const after = deriveClassification(positions, count, { ...baseOpts, buildingMinSupport: 0.66 });

  const cats: Cat[] = ['real', 'artifact', 'veg', 'ground'];

  function confusion(codes: Uint8Array) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (let i = 0; i < count; i++) {
      const pred = codes[i] === DERIVED_BUILDING;
      const truth = buf.truth[i];
      if (pred && truth) tp++;
      else if (pred && !truth) fp++;
      else if (!pred && truth) fn++;
      else tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { tp, fp, fn, tn, precision, recall, f1 };
  }

  function perCategoryBuilding(codes: Uint8Array): Record<Cat, { building: number; total: number }> {
    const out = { real: { building: 0, total: 0 }, artifact: { building: 0, total: 0 }, veg: { building: 0, total: 0 }, ground: { building: 0, total: 0 } };
    for (let i = 0; i < count; i++) {
      const c = buf.cat[i];
      out[c].total++;
      if (codes[i] === DERIVED_BUILDING) out[c].building++;
    }
    return out;
  }

  const cBefore = confusion(before.codes);
  const cAfter = confusion(after.codes);
  const catBefore = perCategoryBuilding(before.codes);
  const catAfter = perCategoryBuilding(after.codes);

  // Artifact roofs flipped BUILDING -> UNCLASSIFIED
  let flipped = 0, artifactTotal = 0, artifactBuildingBefore = 0;
  for (let i = 0; i < count; i++) {
    if (buf.cat[i] !== 'artifact') continue;
    artifactTotal++;
    if (before.codes[i] === DERIVED_BUILDING) artifactBuildingBefore++;
    if (before.codes[i] === DERIVED_BUILDING && after.codes[i] === DERIVED_UNCLASSIFIED) flipped++;
  }

  const pct = (n: number) => (100 * n).toFixed(1) + '%';
  const f3 = (n: number) => n.toFixed(3);

  console.log('=== Synthetic building-support gate evaluation (cellSizeM = 1.0) ===');
  console.log(`corpus points: ${count}`);
  console.log(`categories: real=${catBefore.real.total} artifact=${catBefore.artifact.total} veg=${catBefore.veg.total} ground=${catBefore.ground.total}`);
  console.log('');
  console.log('BUILDING-class confusion vs ground truth');
  console.log('setting                         TP    FP    FN    TN   precision  recall     F1');
  const row = (label: string, c: ReturnType<typeof confusion>) =>
    `${label.padEnd(30)} ${String(c.tp).padStart(5)} ${String(c.fp).padStart(5)} ${String(c.fn).padStart(5)} ${String(c.tn).padStart(5)}    ${f3(c.precision)}    ${f3(c.recall)}   ${f3(c.f1)}`;
  console.log(row('before (buildingMinSupport 0)', cBefore));
  console.log(row('after  (buildingMinSupport 0.66)', cAfter));
  console.log('');
  console.log('Per-category points classified BUILDING (before -> after)');
  for (const cat of cats) {
    console.log(
      `  ${cat.padEnd(9)} ${String(catBefore[cat].building).padStart(5)} -> ${String(catAfter[cat].building).padStart(5)}   (of ${catBefore[cat].total})`,
    );
  }
  console.log('');
  console.log(`Artifact roofs BUILDING before: ${artifactBuildingBefore} of ${artifactTotal}`);
  console.log(`Artifact roofs flipped BUILDING -> UNCLASSIFIED: ${flipped} of ${artifactTotal} (${pct(artifactTotal ? flipped / artifactTotal : 0)})`);
  console.log(`Real-building recall: before ${f3(cBefore.recall)} -> after ${f3(cAfter.recall)}`);
  console.log(`Precision: before ${f3(cBefore.precision)} -> after ${f3(cAfter.precision)}`);
  console.log(`F1: before ${f3(cBefore.f1)} -> after ${f3(cAfter.f1)}`);
}

main();
