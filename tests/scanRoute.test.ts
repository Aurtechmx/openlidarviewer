/**
 * scanRoute.test.ts
 *
 * The manual scan-type override is the safety net for a misdetection: a single
 * pure helper, `resolveScanRoute(detected, override)`, decides the EFFECTIVE
 * route. When the override is 'auto' the detected verdict wins (today's
 * behaviour, untouched); any non-auto override WINS over detection so a misread
 * 360 house is one click to fix.
 */

import { describe, it, expect } from 'vitest';
import { resolveScanRoute } from '../src/terrain/scanRoute';
import type { ScanTypeOverride } from '../src/terrain/scanRoute';
import type { SpaceKind } from '../src/terrain/scanShape';

const DETECTED: readonly SpaceKind[] = ['terrain', 'object', 'interior'];
const NON_AUTO: readonly ScanTypeOverride[] = ['terrain', 'object', 'interior'];

describe('resolveScanRoute — override wins over detection', () => {
  it("override 'auto' returns the detected verdict unchanged", () => {
    for (const detected of DETECTED) {
      expect(resolveScanRoute(detected, 'auto')).toBe(detected);
    }
  });

  it('a non-auto override decides the route regardless of detection', () => {
    for (const detected of DETECTED) {
      for (const override of NON_AUTO) {
        expect(resolveScanRoute(detected, override)).toBe(override);
      }
    }
  });

  it('the reported regression: detected object, forced interior → interior', () => {
    expect(resolveScanRoute('object', 'interior')).toBe('interior');
  });

  it('forcing terrain on a non-terrain scan → terrain', () => {
    expect(resolveScanRoute('interior', 'terrain')).toBe('terrain');
    expect(resolveScanRoute('object', 'terrain')).toBe('terrain');
  });
});
