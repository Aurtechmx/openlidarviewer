/**
 * A floor plan drawn from an unconfirmed scale must say so.
 *
 * `SpaceExportContext` carried `unitToMetres` but dropped `linearUnitKnown`, and
 * that factor is an inert 1 for a local or unknown-unit scan — the ordinary
 * state of the phone and raw-scanner captures this feature exists for. The Space
 * panel discloses it and the report's numeric table prints "source units (scale
 * unverified)", but the plan DRAWING printed "10.0 m (32.8 ft)" dimension lines
 * and "141.0 m2" areas with nothing behind the metre.
 */
import { describe, it, expect } from 'vitest';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';

/** A rectangular room: four walls of points, 10 x 6 x 2.5 in source units. */
function room(): Float32Array {
  const pts: number[] = [];
  const push = (x: number, y: number, z: number) => { pts.push(x, y, z); };
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    for (let k = 0; k < 12; k++) {
      const z = 0.1 + (k / 12) * 2.3;
      push(t * 10, 0, z); push(t * 10, 6, z);
      push(0, t * 6, z); push(10, t * 6, z);
    }
  }
  // A floor, so the band anchor is found.
  for (let i = 0; i <= 60; i++) for (let j = 0; j <= 40; j++) push((i / 60) * 10, (j / 40) * 6, 0);
  return new Float32Array(pts);
}

const UNIT_CAVEAT = /Coordinate units are unverified/i;

describe('floor plan basis lines', () => {
  it('discloses an unverified scale', () => {
    const plan = extractFloorPlan(room(), { upAxis: 'z', unitToMetres: 1, unitKnown: false });
    expect(plan.reasons.some((r) => UNIT_CAVEAT.test(r)), plan.reasons.join(' | ')).toBe(true);
  });

  it('leads with it, so it is read before any dimension is trusted', () => {
    const plan = extractFloorPlan(room(), { upAxis: 'z', unitToMetres: 1, unitKnown: false });
    expect(plan.reasons[0]).toMatch(UNIT_CAVEAT);
  });

  it('says nothing extra when the scale IS confirmed', () => {
    const plan = extractFloorPlan(room(), { upAxis: 'z', unitToMetres: 1, unitKnown: true });
    expect(plan.reasons.some((r) => UNIT_CAVEAT.test(r))).toBe(false);
  });

  it('defaults to confirmed, so every existing caller is unchanged', () => {
    const plan = extractFloorPlan(room(), { upAxis: 'z', unitToMetres: 1 });
    expect(plan.reasons.some((r) => UNIT_CAVEAT.test(r))).toBe(false);
  });

  it('the caveat travels on the model the SVG and PDF both render from', () => {
    // Both artifacts print `model.reasons`; asserting the field is what makes
    // this a claim about the sheet rather than about an internal string.
    const plan = extractFloorPlan(room(), { upAxis: 'z', unitToMetres: 1, unitKnown: false });
    expect(Array.isArray(plan.reasons)).toBe(true);
    expect(plan.reasons.filter((r) => UNIT_CAVEAT.test(r))).toHaveLength(1);
  });
});
