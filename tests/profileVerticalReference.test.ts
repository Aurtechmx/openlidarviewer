/**
 * profileVerticalReference.test.ts
 *
 * One question, one answer: what surface is a profile's height measured from?
 *
 * The flag the scene actually carries — `profileDatumKnown` — reports that the
 * loaded clouds share a render origin. That is not a vertical datum, and the
 * display surfaces used to read it as one and print "Elevation" over heights
 * whose datum was never declared. These tests pin the resolution order that
 * replaces it, and in particular pin the two ways it must REFUSE to upgrade:
 * an unrecognised datum name and a record that itself says `unknown`.
 */

import { describe, it, expect } from 'vitest';
import { resolveProfileVerticalReference } from '../src/render/measure/profileVerticalReference';
import type { ProfileProvenance } from '../src/render/measure/profileProvenance';
import type { VerticalReference } from '../src/geo/height';

/** A provenance record carrying nothing but the unit context under test. */
function record(reference: VerticalReference): ProfileProvenance {
  return {
    recordVersion: 1,
    method: 'corridor-percentile',
    corridorVersion: 1,
    capturedAt: '2026-08-23T00:00:00.000Z',
    up: [0, 0, 1],
    upDegenerate: false,
    sources: [],
    acceptedCount: 0,
    scope: 'empty',
    residentOnly: false,
    complete: null,
    classPolicy: { excludedClasses: [], availableOnEverySource: false },
    units: { linearUnit: 'metre', verticalReference: reference, verticalMetresPerUnit: 1 },
  };
}

describe('resolveProfileVerticalReference', () => {
  it('conflicting render origins make the heights local, whatever else is declared', () => {
    expect(
      resolveProfileVerticalReference({
        datumKnown: false,
        verticalDatum: 'NAVD88',
        provenance: record('orthometric'),
      }),
    ).toBe('local');
  });

  it('an undeclared datum with no record is unknown — never elevation by default', () => {
    expect(resolveProfileVerticalReference({})).toBe('unknown');
    expect(
      resolveProfileVerticalReference({ datumKnown: true, verticalDatum: null, provenance: null }),
    ).toBe('unknown');
  });

  it('the provenance record answers when it has an answer', () => {
    expect(resolveProfileVerticalReference({ provenance: record('ellipsoidal') })).toBe(
      'ellipsoidal',
    );
    expect(resolveProfileVerticalReference({ provenance: record('orthometric') })).toBe(
      'orthometric',
    );
  });

  it('a record that says unknown falls through to the declared datum, not past it', () => {
    expect(
      resolveProfileVerticalReference({ provenance: record('unknown'), verticalDatum: 'NAVD88' }),
    ).toBe('orthometric');
    expect(
      resolveProfileVerticalReference({ provenance: record('unknown'), verticalDatum: null }),
    ).toBe('unknown');
  });

  it('a datum name the tables do not recognise stays unknown', () => {
    expect(resolveProfileVerticalReference({ verticalDatum: 'Site datum (assumed)' })).toBe(
      'unknown',
    );
    expect(resolveProfileVerticalReference({ verticalDatum: '' })).toBe('unknown');
  });

  it('a recognised datum string resolves without a record', () => {
    expect(resolveProfileVerticalReference({ verticalDatum: 'NAVD88' })).toBe('orthometric');
    expect(resolveProfileVerticalReference({ verticalDatum: 'EPSG:4979' })).toBe('ellipsoidal');
    expect(resolveProfileVerticalReference({ verticalDatum: 'MSL depth' })).toBe('depth');
  });

  it('datumKnown omitted is not read as a refusal — only an explicit false is', () => {
    expect(resolveProfileVerticalReference({ verticalDatum: 'NAVD88' })).toBe('orthometric');
    expect(
      resolveProfileVerticalReference({ datumKnown: true, verticalDatum: 'NAVD88' }),
    ).toBe('orthometric');
  });
});
