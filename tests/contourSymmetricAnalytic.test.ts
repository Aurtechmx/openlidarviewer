/**
 * contourSymmetricAnalytic.test.ts — bidirectional contour verification against
 * an analytic reference (§13 hardening).
 *
 * `contourCrossCheck.test.ts` checks one direction only: every OLV vertex lies
 * near a reference contour. That cannot see a MISSING or SPURIOUS component — a
 * whole contour line absent from OLV's output would still pass, because the
 * vertices it did emit are all near the reference. Real geometric agreement
 * needs the SYMMETRIC Hausdorff distance: the reference must also lie near OLV.
 *
 * The reference here is analytic (closed form), so no external tool is needed:
 * for the tilted plane z = x, the isoline at value L is exactly the vertical
 * line x = L. We measure both directions — OLV→line and line→OLV — plus the
 * total contour length, and a negative control that deletes half of OLV's
 * segments and confirms the reverse distance then blows up (which the
 * one-directional check would not catch). E3 self-consistency, not accuracy.
 *
 * Pure: the marching-squares core and closed-form geometry only.
 */

import { describe, it, expect } from 'vitest';
import { contoursAt, type ContourSegment } from '../src/terrain/contour/contoursAt';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function grid(zfn: (x: number, y: number) => number, cols: number, rows: number): DtmGrid {
  const n = cols * rows;
  const z = new Float32Array(n);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) z[row * cols + col] = zfn(col, row);
  }
  return {
    z,
    confidence: new Float32Array(n).fill(100),
    coverage: new Uint8Array(n).fill(2),
    counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', verticalDatum: null, coverageMode: 'full',
    sourcePointCount: n, analyzedPointCount: n, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

/** Distance from point p to segment s. */
function pointToSegment(px: number, py: number, s: ContourSegment): number {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - s.x1) * dx + (py - s.y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.x1 + t * dx), py - (s.y1 + t * dy));
}

/** Directed Hausdorff: max over points of the min distance to any segment. */
function directed(points: ReadonlyArray<[number, number]>, segs: readonly ContourSegment[]): number {
  let worst = 0;
  for (const [px, py] of points) {
    let best = Infinity;
    for (const s of segs) best = Math.min(best, pointToSegment(px, py, s));
    worst = Math.max(worst, best);
  }
  return worst;
}

const CX = 20.5;
const CY = 20.5;

describe('contour symmetric agreement with an analytic tilted plane', () => {
  // z = x → the isoline at value L is the vertical line x = L (world frame).
  const set = contoursAt(grid((x) => x, 41, 41), { intervalM: 10, levels: [20] });
  const segs = set.levels[0].segments;

  it('extracts the isoline at all', () => {
    expect(segs.length).toBeGreaterThan(0);
  });

  it('is symmetric-Hausdorff close to the analytic line (both directions small)', () => {
    // Forward: every OLV endpoint lies near x = 20 (its distance to the line is
    // |x - 20|).
    const olvPoints: [number, number][] = [];
    for (const s of segs) olvPoints.push([s.x1, s.y1], [s.x2, s.y2]);
    const forward = Math.max(...olvPoints.map(([x]) => Math.abs(x - 20)));

    // Reverse: sample the analytic line densely and find the nearest OLV
    // segment for each — this is the direction that catches a missing component.
    const linePoints: [number, number][] = [];
    for (let y = 1; y <= 40; y += 0.5) linePoints.push([20, y]);
    const reverse = directed(linePoints, segs);

    const symmetric = Math.max(forward, reverse);
    // Marching-squares linear interpolation keeps both within a fraction of a
    // cell of the true line.
    expect(forward).toBeLessThan(0.6);
    expect(reverse).toBeLessThan(0.9);
    expect(symmetric).toBeLessThan(0.9);
  });

  it('spans the full covered extent (total length ~= the analytic length, no gaps)', () => {
    const total = segs.reduce((n, s) => n + Math.hypot(s.x2 - s.x1, s.y2 - s.y1), 0);
    // The analytic line crosses ~40 cells of relief; the extracted contour's
    // total length matches that span to a couple of cells.
    expect(total).toBeGreaterThan(38);
    expect(total).toBeLessThan(42);
  });

  it('NEGATIVE CONTROL: dropping half the segments makes the reverse distance blow up (a gap the one-directional check misses)', () => {
    // Delete the lower half of the contour (y < 20). Forward agreement is
    // UNCHANGED — every surviving vertex is still on the line — so a
    // one-directional check still passes. The reverse direction, sampling the
    // deleted region, jumps to a full component's width.
    const upperOnly = segs.filter((s) => s.y1 >= 20 && s.y2 >= 20);
    const olvPoints: [number, number][] = [];
    for (const s of upperOnly) olvPoints.push([s.x1, s.y1], [s.x2, s.y2]);
    const forwardStill = Math.max(...olvPoints.map(([x]) => Math.abs(x - 20)));
    const deletedLine: [number, number][] = [];
    for (let y = 1; y <= 18; y += 0.5) deletedLine.push([20, y]);
    const reverseNow = directed(deletedLine, upperOnly);

    expect(forwardStill).toBeLessThan(0.6); // one-directional check still "passes"
    expect(reverseNow).toBeGreaterThan(2); // symmetric check catches the gap
  });

  it('a cone contour is a closed loop the reference samples all the way around', () => {
    // A concentric-circle isoline: sampling the analytic circle all the way
    // round must stay near OLV segments (completeness for a closed component).
    const cone = (x: number, y: number) => Math.hypot(x - (CX - 0.5), y - (CY - 0.5));
    const cset = contoursAt(grid(cone, 41, 41), { intervalM: 10, levels: [12] });
    const csegs = cset.levels[0].segments;
    const circle: [number, number][] = [];
    for (let a = 0; a < Math.PI * 2; a += 0.1) {
      circle.push([CX + 12 * Math.cos(a), CY + 12 * Math.sin(a)]);
    }
    expect(directed(circle, csegs)).toBeLessThan(0.9);
  });
});
