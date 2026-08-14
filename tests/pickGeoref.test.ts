/**
 * pickGeoref.test.ts — an annotation's stored CRS label must be the RESOLVED
 * per-cloud CRS, not the file's declared one. After a user override (source A →
 * resolved B) a new annotation would otherwise carry label A while the report
 * says the dataset is B, contaminating the PDF's annotation section.
 */
import { describe, it, expect } from 'vitest';
import { annotationGeorefFor } from '../src/render/annotate/pickGeoref';

const pick = (declaredName?: string) => ({
  cloud: {
    name: 'scan',
    metadata: declaredName ? { crs: { name: declaredName } } : undefined,
    worldXYZ: (_i: number): [number, number, number] => [1, 2, 3],
  },
  index: 0,
});

describe('annotationGeorefFor — resolved per-cloud CRS label (audit blocker)', () => {
  it('stores the resolved label B, not the file-declared A', () => {
    expect(annotationGeorefFor(pick('CRS-A'), 'CRS-B')?.crs).toBe('CRS-B');
  });

  it('a resolved null (Local / no-CRS) stores no label and never resurrects A', () => {
    expect(annotationGeorefFor(pick('CRS-A'), null)?.crs).toBeUndefined();
  });

  it('no resolved label falls back to the file declaration (pure caller)', () => {
    expect(annotationGeorefFor(pick('CRS-A'))?.crs).toBe('CRS-A');
  });
});
