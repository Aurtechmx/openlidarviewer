/**
 * exportModeAvailability.test.ts — the image-export mode availability rules,
 * extracted from Viewer.availableImageExportModes so they are testable without a
 * WebGL context (blocker #1 decomposition).
 */
import { describe, it, expect } from 'vitest';
import { imageExportModeAvailability } from '../src/render/exportModeAvailability';

const facts = (over: Partial<Parameters<typeof imageExportModeAvailability>[0]> = {}) =>
  imageExportModeAvailability({
    hasAabb: true, zRange: 10, hasIntensity: true, hasClassification: true, hasNormals: true, ...over,
  });

describe('imageExportModeAvailability', () => {
  it('orthographic-rgb is always available', () => {
    expect(facts({ hasAabb: false }).get('orthographic-rgb')).toEqual({ available: true });
  });

  it('height-map needs a loaded cloud with a measurable Z range', () => {
    expect(facts({ hasAabb: false }).get('height-map')).toMatchObject({ available: false, reason: /No cloud/ });
    expect(facts({ zRange: 0 }).get('height-map')).toMatchObject({ available: false, reason: /height range/ });
    expect(facts({ zRange: 5 }).get('height-map')).toEqual({ available: true });
  });

  it('intensity / classification need both an AABB and the channel', () => {
    expect(facts({ hasIntensity: false }).get('intensity')).toMatchObject({ available: false, reason: /intensity channel/ });
    expect(facts({ hasClassification: false }).get('classification')).toMatchObject({ available: false, reason: /classification channel/ });
    expect(facts({ hasAabb: false }).get('intensity')).toMatchObject({ available: false, reason: /No cloud/ });
  });

  it('normal needs the channel regardless of AABB', () => {
    expect(facts({ hasNormals: false }).get('normal')).toMatchObject({ available: false, reason: /no per-point normals/ });
    expect(facts({ hasNormals: true }).get('normal')).toEqual({ available: true });
  });
});
