/**
 * profileSectionExtract.test.ts
 *
 * The scan must find exactly the returns the corridor accepts, keep each one
 * attached to its own source, and stay independent of the order sources
 * became available.
 *
 * The bounds pre-test is the part that can lose data silently: a box wrongly
 * rejected drops every return in it and reports success. It is checked
 * differentially against the same scan with the test disabled, over boxes
 * placed on and across the corridor limits.
 */
import { describe, it, expect } from 'vitest';
import { buildProfileFrame } from '../src/render/measure/profileGeometry';
import {
  extractProfileSection,
  extractProfileSectionChunks,
  boundsMayIntersectCorridor,
  type ProfileSectionSourceView,
  type ProfileSourceBounds,
} from '../src/render/measure/profileSectionExtract';
import { profileSectionHas } from '../src/render/measure/profileSectionBuilder';
import type { Vec3 } from '../src/render/navMath';

const golden = (i: number): number => (i * 0.6180339887498949) % 1;

/** A source backed by explicit float64 coordinates. */
function makeSource(
  slot: number,
  coords: number[],
  opts: { bounds?: ProfileSourceBounds | null; intensity?: boolean } = {},
): ProfileSectionSourceView {
  const n = coords.length / 3;
  const intensity = opts.intensity ? new Uint16Array(n) : undefined;
  if (intensity) for (let i = 0; i < n; i++) intensity[i] = 100 * (slot + 1) + i;
  let bounds: ProfileSourceBounds | null | undefined = opts.bounds;
  if (bounds === undefined) {
    const mn: [number, number, number] = [Infinity, Infinity, Infinity];
    const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++)
      for (let c = 0; c < 3; c++) {
        const v = coords[i * 3 + c]!;
        if (v < mn[c]!) mn[c] = v;
        if (v > mx[c]!) mx[c] = v;
      }
    bounds = { min: mn, max: mx };
  }
  return {
    slot,
    pointCount: n,
    channels: intensity ? { intensity } : null,
    bounds,
    readProjectXYZ(index, out) {
      out[0] = coords[index * 3]!;
      out[1] = coords[index * 3 + 1]!;
      out[2] = coords[index * 3 + 2]!;
    },
  };
}

/** Points spread over and well beyond a section, deterministically. */
function spread(n: number, cx: number, cy: number, cz: number, r: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(cx + (golden(i) - 0.5) * r);
    out.push(cy + (golden(i * 3 + 1) - 0.5) * r);
    out.push(cz + (golden(i * 7 + 2) - 0.5) * r);
  }
  return out;
}

const UP: Vec3 = [0, 0, 1];
const A: Vec3 = [0, 0, 0];
const B: Vec3 = [50, 0, 0];
const FRAME = buildProfileFrame(A, B, UP);
const BAND = 3;

describe('the bounds pre-test never drops an accepted return', () => {
  // Boxes straddling every corridor limit: before the start cap, past the end
  // cap, either side of the lateral band, on the axis, and far away.
  const centres: [number, number, number][] = [
    [25, 0, 0],
    [-6, 0, 0],
    [56, 0, 0],
    [25, 3, 0],
    [25, -3, 0],
    [25, 20, 0],
    [-40, -40, 10],
    [0, 0, 500],
    [50, 3, -200],
  ];

  for (const [cx, cy, cz] of centres) {
    for (const r of [1, 8, 40]) {
      it(`box at (${cx}, ${cy}, ${cz}) radius ${r}`, () => {
        const coords = spread(400, cx, cy, cz, r);
        const src = makeSource(0, coords);
        const withTest = extractProfileSection({
          frame: FRAME,
          band: BAND,
          sources: [src],
        });
        const withoutTest = extractProfileSection({
          frame: FRAME,
          band: BAND,
          sources: [src],
          skipBoundsTest: true,
        });
        expect(withTest.points.count).toBe(withoutTest.points.count);
        expect(Array.from(withTest.points.pointIndex)).toEqual(
          Array.from(withoutTest.points.pointIndex),
        );
        // A skip is only legitimate when the unrestricted scan found nothing.
        if (withTest.skippedSlots.length > 0) {
          expect(withoutTest.points.count).toBe(0);
        }
      });
    }
  }

  it('skips a box that genuinely cannot contribute', () => {
    const far = makeSource(0, spread(200, 400, 400, 0, 5));
    const r = extractProfileSection({ frame: FRAME, band: BAND, sources: [far] });
    expect(r.skippedSlots).toEqual([0]);
    expect(r.examined).toBe(0);
    expect(r.points.count).toBe(0);
  });

  it('scans a source whose bounds are unknown', () => {
    const src = makeSource(0, spread(200, 25, 0, 0, 4), { bounds: null });
    const r = extractProfileSection({ frame: FRAME, band: BAND, sources: [src] });
    expect(r.skippedSlots).toEqual([]);
    expect(r.examined).toBe(200);
    expect(r.points.count).toBeGreaterThan(0);
  });

  it('scans rather than rejects when a bound is not finite', () => {
    const bad: ProfileSourceBounds = { min: [Number.NaN, 0, 0], max: [1, 1, 1] };
    expect(boundsMayIntersectCorridor(FRAME, BAND, bad)).toBe(true);
    const inverted: ProfileSourceBounds = { min: [10, 0, 0], max: [-10, 1, 1] };
    expect(boundsMayIntersectCorridor(FRAME, BAND, inverted)).toBe(true);
  });
});

describe('the scan keeps sources apart and stays deterministic', () => {
  const s0 = makeSource(0, spread(300, 12, 0, 0, 4), { intensity: true });
  const s1 = makeSource(1, spread(300, 38, 0, 0, 4), { intensity: true });
  const s2 = makeSource(2, spread(300, 400, 0, 0, 4));

  it('records the slot and index each return came from', () => {
    const r = extractProfileSection({ frame: FRAME, band: BAND, sources: [s0, s1, s2] });
    expect(r.points.count).toBeGreaterThan(0);
    expect(r.skippedSlots).toEqual([2]);
    for (let k = 0; k < r.points.count; k++) {
      const slot = r.points.sourceSlot[k]!;
      expect(slot === 0 || slot === 1).toBe(true);
      expect(profileSectionHas(r.points, k, 'intensity')).toBe(true);
      expect(r.points.intensity![k]).toBe(100 * (slot + 1) + r.points.pointIndex[k]!);
    }
  });

  it('gives the same result whatever order the sources arrived in', () => {
    // Sorting by slot is the caller's job; the scan must be a pure function
    // of the sequence it is handed, which is what makes that sort sufficient.
    const forward = extractProfileSection({ frame: FRAME, band: BAND, sources: [s0, s1] });
    const again = extractProfileSection({ frame: FRAME, band: BAND, sources: [s0, s1] });
    expect(Array.from(again.points.chainage)).toEqual(Array.from(forward.points.chainage));
    expect(Array.from(again.points.sourceSlot)).toEqual(Array.from(forward.points.sourceSlot));

    const reversed = extractProfileSection({ frame: FRAME, band: BAND, sources: [s1, s0] });
    expect(reversed.points.count).toBe(forward.points.count);
    const key = (
      p: { sourceSlot: Uint16Array; pointIndex: Uint32Array },
      i: number,
    ): string => `${p.sourceSlot[i]}:${p.pointIndex[i]}`;
    const setA = new Set<string>();
    const setB = new Set<string>();
    for (let i = 0; i < forward.points.count; i++) setA.add(key(forward.points, i));
    for (let i = 0; i < reversed.points.count; i++) setB.add(key(reversed.points, i));
    expect(setB).toEqual(setA);
  });

  it('does not modify a source buffer', () => {
    const coords = spread(200, 25, 0, 0, 4);
    const copy = coords.slice();
    extractProfileSection({ frame: FRAME, band: BAND, sources: [makeSource(0, coords)] });
    expect(coords).toEqual(copy);
  });
});

describe('the scan yields and can be abandoned', () => {
  const big = makeSource(0, spread(5000, 25, 0, 0, 6));

  it('yields on the requested cadence', () => {
    const it2 = extractProfileSectionChunks({
      frame: FRAME,
      band: BAND,
      sources: [big],
      chunkSize: 1000,
    });
    const marks: number[] = [];
    let step = it2.next();
    while (!step.done) {
      marks.push(step.value);
      step = it2.next();
    }
    expect(marks).toEqual([1000, 2000, 3000, 4000, 5000]);
    expect(step.value.aborted).toBe(false);
    expect(step.value.examined).toBe(5000);
  });

  it('reports an abort rather than returning a short result as complete', () => {
    const signal = { aborted: false };
    const it2 = extractProfileSectionChunks({
      frame: FRAME,
      band: BAND,
      sources: [big],
      chunkSize: 1000,
      signal,
    });
    it2.next();
    (signal as { aborted: boolean }).aborted = true;
    let step = it2.next();
    while (!step.done) step = it2.next();
    expect(step.value.aborted).toBe(true);
    expect(step.value.examined).toBeLessThan(5000);
  });
});

describe('placement precision survives the scan', () => {
  it('keeps a far-from-origin layer to float64 height resolution', () => {
    // A mounted layer 2 km out, with structure below the float32 spacing at
    // that magnitude, is the case the float64 height field exists for.
    const base = 2_000_000;
    const coords: number[] = [];
    const heights: number[] = [];
    for (let i = 0; i < 64; i++) {
      const h = base + i * 0.001;
      coords.push(25, 0, h);
      heights.push(h);
    }
    const r = extractProfileSection({
      frame: FRAME,
      band: BAND,
      sources: [makeSource(0, coords, { bounds: null })],
    });
    expect(r.points.count).toBe(64);
    for (let k = 0; k < 64; k++) {
      expect(r.points.height[k]).toBe(heights[k]);
    }
    // The same values through float32 collapse to far fewer distinct heights.
    const f32 = new Float32Array(heights);
    expect(new Set(Array.from(f32)).size).toBeLessThan(64);
  });
});
