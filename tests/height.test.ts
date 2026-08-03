/**
 * tests/height.test.ts
 *
 * The explicit vertical value type: reference classification, honest labelling,
 * and metres conversion. The central honesty claim is that an undeclared or
 * unrecognised vertical datum classifies as `'unknown'` and labels as a datum-
 * unknown height, never as a silently-assumed elevation.
 */

import { describe, expect, test } from 'vitest';
import {
  type HeightValue,
  type VerticalReference,
  heightInMetres,
  heightLabel,
  heightReferenceNote,
  makeHeight,
  verticalReferenceFromDatum,
} from '../src/geo/height';

describe('makeHeight / heightInMetres', () => {
  test('omitting the scale leaves metresPerUnit undefined (unknown scale)', () => {
    const h = makeHeight(123.4, 'orthometric');
    expect(h).toEqual({ value: 123.4, reference: 'orthometric' });
    expect(h.metresPerUnit).toBeUndefined();
  });

  test('a stated scale is carried and converts to metres', () => {
    const feet = makeHeight(500, 'orthometric', 0.3048);
    expect(feet.metresPerUnit).toBe(0.3048);
    expect(heightInMetres(feet)).toBeCloseTo(152.4, 6);
  });

  test('a metre height converts to itself', () => {
    expect(heightInMetres(makeHeight(42, 'ellipsoidal', 1))).toBe(42);
  });

  test('an unknown vertical scale has NO metres value — never treats the raw magnitude as metres', () => {
    // The dishonest failure this guards: a foot height with no declared unit
    // read straight through as "152 metres".
    expect(heightInMetres(makeHeight(500, 'orthometric'))).toBeUndefined();
  });

  test('a non-finite scale yields no metres value', () => {
    const bad: HeightValue = { value: 10, metresPerUnit: Number.NaN, reference: 'orthometric' };
    expect(heightInMetres(bad)).toBeUndefined();
  });
});

describe('verticalReferenceFromDatum', () => {
  test('an undeclared datum is unknown — not upgraded to a reference', () => {
    expect(verticalReferenceFromDatum({})).toBe('unknown');
    expect(verticalReferenceFromDatum({ verticalDatum: '' })).toBe('unknown');
    expect(verticalReferenceFromDatum({ verticalDatum: '   ' })).toBe('unknown');
  });

  test('orthometric height datums, by EPSG', () => {
    for (const code of [5703, 5701, 5714, 3855, 5773, 6647, 5705, 5612]) {
      expect(verticalReferenceFromDatum({ verticalEpsg: code })).toBe('orthometric');
    }
  });

  test('depth axis is its own class, not orthometric', () => {
    expect(verticalReferenceFromDatum({ verticalEpsg: 5715 })).toBe('depth');
    expect(verticalReferenceFromDatum({ verticalDatum: 'MSL depth' })).toBe('depth');
    // Height and depth are opposite axes — the height MSL code must not read as depth.
    expect(verticalReferenceFromDatum({ verticalEpsg: 5714 })).toBe('orthometric');
  });

  test('WGS 84 3D is ellipsoidal, not a sea-level elevation', () => {
    expect(verticalReferenceFromDatum({ verticalEpsg: 4979 })).toBe('ellipsoidal');
    expect(verticalReferenceFromDatum({ verticalDatum: 'EPSG:4979' })).toBe('ellipsoidal');
  });

  test('names resolve the same as codes (catalog name vs EPSG string)', () => {
    expect(verticalReferenceFromDatum({ verticalDatum: 'NAVD88' })).toBe('orthometric');
    expect(verticalReferenceFromDatum({ verticalDatum: 'navd88' })).toBe('orthometric');
    expect(verticalReferenceFromDatum({ verticalDatum: 'EPSG:5703' })).toBe('orthometric');
    expect(verticalReferenceFromDatum({ verticalDatum: '5703' })).toBe('orthometric');
    expect(verticalReferenceFromDatum({ verticalDatum: 'EGM2008 height' })).toBe('orthometric');
  });

  test('the authoritative EPSG wins over the name', () => {
    expect(
      verticalReferenceFromDatum({ verticalEpsg: 5715, verticalDatum: 'NAVD88' }),
    ).toBe('depth');
  });

  test('a present but unrecognised datum is unknown — never a guessed orthometric', () => {
    expect(verticalReferenceFromDatum({ verticalEpsg: 999999 })).toBe('unknown');
    expect(verticalReferenceFromDatum({ verticalDatum: 'Some local benchmark' })).toBe('unknown');
    // Free-text "ellipsoid" is deliberately NOT accepted as ellipsoidal.
    expect(verticalReferenceFromDatum({ verticalDatum: 'WGS 84 (ellipsoid)' })).toBe('unknown');
  });

  test('placeholder / invalid codes are unknown, never a datum', () => {
    expect(verticalReferenceFromDatum({ verticalEpsg: 0 })).toBe('unknown');
    expect(verticalReferenceFromDatum({ verticalEpsg: -1 })).toBe('unknown');
    expect(verticalReferenceFromDatum({ verticalEpsg: Number.NaN })).toBe('unknown');
  });
});

describe('heightLabel', () => {
  test('every reference has a label; unknown is honest about the missing datum', () => {
    const labels: Record<VerticalReference, string> = {
      ellipsoidal: heightLabel('ellipsoidal'),
      orthometric: heightLabel('orthometric'),
      depth: heightLabel('depth'),
      local: heightLabel('local'),
      unknown: heightLabel('unknown'),
    };
    expect(labels.ellipsoidal).toBe('Ellipsoidal height');
    expect(labels.orthometric).toBe('Elevation');
    expect(labels.depth).toBe('Depth');
    expect(labels.local).toBe('Height (local frame)');
    expect(labels.unknown).toBe('Height (datum unknown)');
    // The unknown label must NOT read as a plain elevation — that is the whole point.
    expect(labels.unknown).not.toBe('Elevation');
    expect(labels.unknown.toLowerCase()).toContain('unknown');
  });
});

describe('heightReferenceNote', () => {
  test('the unknown note states the consequence rather than implying a datum', () => {
    const note = heightReferenceNote('unknown');
    expect(note.toLowerCase()).toContain('no vertical datum');
    expect(note.toLowerCase()).toContain('not tied');
  });

  test('the ellipsoidal note warns it is not a sea-level elevation', () => {
    expect(heightReferenceNote('ellipsoidal').toLowerCase()).toContain('not a sea-level');
  });

  test('every reference yields a non-empty note', () => {
    for (const r of ['ellipsoidal', 'orthometric', 'depth', 'local', 'unknown'] as const) {
      expect(heightReferenceNote(r).length).toBeGreaterThan(0);
    }
  });
});
