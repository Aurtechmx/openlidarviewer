/**
 * observatoryProvenance.test.ts — what an Observatory run records about its
 * input, and what its package writes about the run: the resident positions
 * digest covers every resident position, the runner passes planning and the
 * live file name / unit through, and the package fills the field.bin grid
 * shape and each method's manifest params.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { residentPositionsDigest } from '../src/app/residentPositionsDigest';
import { runObservatoryOverCloud, type ObservatoryCloudInput, type ObservatoryRunOptions } from '../src/app/observatoryFromCloud';
import { createObservatoryRunner } from '../src/app/observatoryRunner';
import { observatoryLiveDeps } from '../src/app/observatoryLiveDeps';
import { buildObservatoryPackage } from '../src/export/observatoryPackage';
import { domainGrid } from '../src/observation/ledger';
import type { AcquisitionStation } from '../src/model/AcquisitionStations';

function station(id: string, origin: readonly [number, number, number], n: number): AcquisitionStation {
  return { id, source: 'ptx-block', pose: { worldTranslation: origin, localPositionSource: 'not-applicable' }, recordRange: { start: 0, end: n }, originStatus: 'DECLARED' };
}

function cloudOf(positions: Float32Array): ObservatoryCloudInput {
  return {
    positions,
    sourceOrigin: [0, 0, 0],
    bounds: () => ({ min: [0, -1, -1], max: [6, 1, 1] }),
    acquisitionStations: { kind: 'acquisition-stations', stations: [station('station-1', [0, 0, 0], positions.length / 3)] },
  };
}

const WALL = [5, 0.2, 0.2, 5, 0.21, 0.2, 5, 0.19, 0.2, 5, 0.2, 0.21, 5, 0.2, 0.19, 2, 0, 0];
const OPTS: ObservatoryRunOptions = { voxelEdge: 0.5, declaredStepBudget: 1_000_000, filename: 'fixture.ptx', metresPerUnit: 1, buildTag: 'test' };

/** Unzip a stored (method 0) ZIP into name -> text. */
function unzipText(zip: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let off = 0;
  while (off + 30 <= zip.length && dv.getUint32(off, true) === 0x04034b50) {
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extra = dv.getUint16(off + 28, true);
    const name = new TextDecoder().decode(zip.subarray(off + 30, off + 30 + nameLen));
    const start = off + 30 + nameLen + extra;
    out.set(name, new TextDecoder('latin1').decode(zip.subarray(start, start + size)));
    off = start + size;
  }
  return out;
}

describe('resident positions digest', () => {
  it('is SHA-256 of the little-endian float32 bytes', () => {
    const p = new Float32Array([1, 2.5, -3, 1e-7, 42, 0]);
    const le = Buffer.alloc(p.length * 4);
    p.forEach((v, i) => le.writeFloatLE(v, i * 4));
    expect(residentPositionsDigest(p)).toBe(createHash('sha256').update(le).digest('hex'));
  });

  it('two runs equal in the first 3000 values and different after get different digests', () => {
    const n = 3000 + 3 * WALL.length;
    const a = new Float32Array(n);
    for (let i = 0; i < 3000; i++) a[i] = 5 + (i % 3) * 0.001;
    a.set(WALL, 3000);
    const b = a.slice();
    b[n - 1] = 0.5;
    expect(residentPositionsDigest(a)).not.toBe(residentPositionsDigest(b));
    const ra = runObservatoryOverCloud(cloudOf(a), OPTS);
    const rb = runObservatoryOverCloud(cloudOf(b), OPTS);
    const ra2 = runObservatoryOverCloud(cloudOf(a.slice()), OPTS);
    if (ra.status !== 'ok' || rb.status !== 'ok' || ra2.status !== 'ok') throw new Error('run not ok');
    expect(ra.record.source.sourceDigest).not.toBe(rb.record.source.sourceDigest);
    expect(ra.record.source.sourceDigest).toBe(ra2.record.source.sourceDigest);
    expect(ra.record.source.sourceDigest).toBe(residentPositionsDigest(a));
  });

  it('hashes 10M floats in bounded time and matches chunk-free hashing', () => {
    const p = new Float32Array(10_000_000);
    for (let i = 0; i < p.length; i++) p[i] = (i % 9973) * 0.25;
    const t0 = performance.now();
    const d = residentPositionsDigest(p);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(10_000);
    const le = Buffer.from(p.buffer, p.byteOffset, p.byteLength); // host is little-endian in CI
    expect(d).toBe(createHash('sha256').update(le).digest('hex'));
  });
});

describe('runner options', () => {
  const cloud = cloudOf(new Float32Array(WALL));

  it('passes planning from buildOptions through to the run', () => {
    let seen: ObservatoryRunOptions | null = null;
    const runner = createObservatoryRunner({
      getActiveCloud: () => cloud, getDatasetId: () => 'a', getCrsRevision: () => 0,
      buildOptions: () => ({ filename: null, metresPerUnit: null, buildTag: 't', planning: false }),
      compute: (c, o) => { seen = o; return runObservatoryOverCloud(c, o); },
    });
    runner.run();
    expect(seen!.planning).toBe(false);
  });

  it('live deps read the base file name only and the known unit factor', () => {
    const scans = { activeCloud: () => ({ ...cloud, name: 'C:\\data\\site/scans/north.ptx' }), activeId: 'x' };
    const crs = { crsRevision: () => 3, context: () => ({ linearUnitToMetres: 0.3048, linearUnitKnown: true }) };
    const deps = observatoryLiveDeps(scans, crs, 'b1');
    expect(deps.buildOptions()).toEqual({ filename: 'north.ptx', metresPerUnit: 0.3048, buildTag: 'b1' });
    expect(deps.getDatasetId()).toBe('x');
    expect(deps.getCrsRevision()).toBe(3);
    const unknown = observatoryLiveDeps(scans, { crsRevision: () => 0, context: () => ({ linearUnitToMetres: 1, linearUnitKnown: false }) }, 'b1');
    expect(unknown.buildOptions().metresPerUnit).toBeNull();
  });
});

describe('observatory package provenance', () => {
  const outcome = runObservatoryOverCloud(cloudOf(new Float32Array(WALL)), OPTS);
  if (outcome.status !== 'ok') throw new Error('run not ok');
  const files = unzipText(buildObservatoryPackage(outcome.record, outcome.rows, outcome.frontier.frontierVoxelKeys, {
    basename: 'o', generationDateIso: '2026-01-01T00:00:00.000Z', planning: outcome.planning ?? null, declaredStepBudget: OPTS.declaredStepBudget,
  }));

  it('fieldDigest is unchanged from the value before this change, with or without a unit factor', () => {
    expect(outcome.record.fieldDigest).toBe('d351a791');
    const feet = runObservatoryOverCloud(cloudOf(new Float32Array(WALL)), { ...OPTS, metresPerUnit: 0.3048 });
    const unknown = runObservatoryOverCloud(cloudOf(new Float32Array(WALL)), { ...OPTS, metresPerUnit: null });
    if (feet.status !== 'ok' || unknown.status !== 'ok') throw new Error('run not ok');
    expect(feet.record.fieldDigest).toBe('d351a791');
    expect(unknown.record.fieldDigest).toBe('d351a791');
    // The unit factor reaches the planning instrument model (1.5 m height in source units).
    expect(feet.planning!.instrumentModel.heightAboveSurface).toBeCloseTo(1.5 / 0.3048, 9);
    expect(unknown.planning!.instrumentModel.heightAboveSurface).toBe(1.5);
  });

  it('field.json carries the grid shape from domainGrid', () => {
    const header = JSON.parse(files.get('o/field.json')!);
    const g = domainGrid(outcome.record.domain, outcome.record.voxelEdge);
    expect(header.grid).toEqual({ nx: g.nx, ny: g.ny, nz: g.nz });
    expect(g.nx * g.ny * g.nz).toBeGreaterThan(0);
  });

  it('every manifest op of a registered method carries non-empty params', () => {
    const manifest = JSON.parse(files.get('o/processing-manifest.json')!);
    const obsOps = manifest.ops.filter((op: { method: string }) => op.method.startsWith('olv.observation.'));
    expect(obsOps.length).toBe(outcome.record.methods.length);
    for (const op of obsOps) expect(Object.keys(op.params).length).toBeGreaterThan(0);
    const ledger = obsOps.find((op: { method: string }) => op.method === 'olv.observation.ledger@1');
    expect(ledger.params).toMatchObject({ voxelEdge: 0.5, declaredStepBudget: 1_000_000, tauAbs: 0.25, tauRel: 0 });
    const states = obsOps.find((op: { method: string }) => op.method === 'olv.observation.states@1');
    expect(states.params).toMatchObject({ p_solid: 0.9, p_empty: 0.1, n_min: 5, ruleSet: 'OB-ST-THRESHOLDS' });
    const gain = obsOps.find((op: { method: string }) => op.method === 'olv.observation.coverage-gain@1');
    expect(gain.params).toHaveProperty('candidateCap');
    expect(gain.params).toHaveProperty('candidateSpacing');
    const pick = obsOps.find((op: { method: string }) => op.method === 'olv.observation.station-suggestion@1');
    expect(pick.params).toHaveProperty('stationCount');
  });

  it('the manifest is deterministic across builds of the same run', () => {
    const again = unzipText(buildObservatoryPackage(outcome.record, outcome.rows, outcome.frontier.frontierVoxelKeys, {
      basename: 'o', generationDateIso: '2026-01-01T00:00:00.000Z', planning: outcome.planning ?? null, declaredStepBudget: OPTS.declaredStepBudget,
    }));
    expect(again.get('o/processing-manifest.json')).toBe(files.get('o/processing-manifest.json'));
    const manifest = JSON.parse(files.get('o/processing-manifest.json')!);
    for (const op of manifest.ops.filter((o: { method: string }) => o.method.startsWith('olv.observation.'))) {
      const keys = Object.keys(op.params);
      expect(keys).toEqual([...keys].sort());
    }
  });

  it('re-running with the manifest params reproduces the fieldDigest', () => {
    const manifest = JSON.parse(files.get('o/processing-manifest.json')!);
    const ledger = manifest.ops.find((op: { method: string }) => op.method === 'olv.observation.ledger@1').params;
    const rerun = runObservatoryOverCloud(cloudOf(new Float32Array(WALL)), {
      voxelEdge: ledger.voxelEdge, declaredStepBudget: ledger.declaredStepBudget, filename: null, metresPerUnit: null, buildTag: 'other', planning: false,
    });
    if (rerun.status !== 'ok') throw new Error('rerun not ok');
    expect(rerun.record.fieldDigest).toBe(outcome.record.fieldDigest);
  });

  it('README and passport say the whole-file hash is unavailable', () => {
    expect(files.get('o/README.md')).toMatch(/Analysis input SHA-256  [0-9a-f]{64}/);
    expect(files.get('o/README.md')).toMatch(/Source SHA-256  not recorded by this export path/);
    const passport = JSON.parse(files.get('o/scientific-passport.json')!);
    expect(passport.source.sha256).toBeNull();
  });
});
