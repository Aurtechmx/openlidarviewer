/**
 * mapExportLayout.test.ts
 *
 * Tests for the pure-data layout builder that places the scale bar,
 * north arrow, CRS label, and legend on a map-export canvas.
 */

import { describe, it, expect } from 'vitest';
import {
  composeMapExportLayout,
  formatCrsLabel,
} from '../src/render/export/mapExportLayout';

describe('composeMapExportLayout — slot reservation', () => {
  it('returns no slots when none are requested', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeScaleBar: false,
      includeNorthArrow: false,
      includeCrsLabel: false,
      includeLegend: false,
    });
    expect(layout.scaleBar).toBeUndefined();
    expect(layout.northArrow).toBeUndefined();
    expect(layout.crsLabel).toBeUndefined();
    expect(layout.legend).toBeUndefined();
  });

  it('places the scale bar in the bottom-left', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeScaleBar: true,
      includeNorthArrow: false,
      includeCrsLabel: false,
      includeLegend: false,
    });
    expect(layout.scaleBar).toBeDefined();
    expect(layout.scaleBar!.x).toBeLessThan(layout.scaleBar!.width);
    // Bottom-anchored: y should sit close to canvas height.
    expect(layout.scaleBar!.y).toBeGreaterThan(1000);
  });

  it('places the north arrow in the top-right', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeScaleBar: false,
      includeNorthArrow: true,
      includeCrsLabel: false,
      includeLegend: false,
    });
    expect(layout.northArrow).toBeDefined();
    // Top-anchored: y is small.
    expect(layout.northArrow!.y).toBeLessThan(100);
    // Right-anchored: x near the right edge.
    expect(layout.northArrow!.x).toBeGreaterThan(1800);
  });

  it('places the CRS label in the bottom-right', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeScaleBar: false,
      includeNorthArrow: false,
      includeCrsLabel: true,
      includeLegend: false,
    });
    expect(layout.crsLabel).toBeDefined();
    expect(layout.crsLabel!.y).toBeGreaterThan(1000);
    expect(layout.crsLabel!.x).toBeGreaterThan(1500);
  });

  it('places the legend in the top-left', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeScaleBar: false,
      includeNorthArrow: false,
      includeCrsLabel: false,
      includeLegend: true,
    });
    expect(layout.legend).toBeDefined();
    expect(layout.legend!.y).toBeLessThan(100);
    expect(layout.legend!.x).toBeLessThan(100);
  });
});

describe('composeMapExportLayout — slot sizes are deterministic', () => {
  it('uses the same scale-bar width across canvas sizes', () => {
    const a = composeMapExportLayout({
      canvasWidth: 800,
      canvasHeight: 600,
      includeScaleBar: true,
      includeNorthArrow: false,
      includeCrsLabel: false,
      includeLegend: false,
    });
    const b = composeMapExportLayout({
      canvasWidth: 4000,
      canvasHeight: 3000,
      includeScaleBar: true,
      includeNorthArrow: false,
      includeCrsLabel: false,
      includeLegend: false,
    });
    expect(a.scaleBar!.width).toBe(b.scaleBar!.width);
    expect(a.scaleBar!.height).toBe(b.scaleBar!.height);
  });

  it('respects a custom padding value', () => {
    const tight = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeNorthArrow: true,
      includeScaleBar: false,
      includeCrsLabel: false,
      includeLegend: false,
      padding: 8,
    });
    const loose = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeNorthArrow: true,
      includeScaleBar: false,
      includeCrsLabel: false,
      includeLegend: false,
      padding: 48,
    });
    expect(tight.northArrow!.x).toBeGreaterThan(loose.northArrow!.x);
  });
});

describe('composeMapExportLayout — map area', () => {
  it('always returns a map area inside the padded frame', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 1920,
      canvasHeight: 1080,
      includeScaleBar: true,
      includeNorthArrow: true,
      includeCrsLabel: true,
      includeLegend: true,
    });
    expect(layout.mapArea.x).toBe(24);
    expect(layout.mapArea.y).toBe(24);
    expect(layout.mapArea.width).toBe(1920 - 48);
    expect(layout.mapArea.height).toBe(1080 - 48);
  });

  it('returns non-negative dimensions on a tiny canvas', () => {
    const layout = composeMapExportLayout({
      canvasWidth: 10,
      canvasHeight: 10,
      includeScaleBar: false,
      includeNorthArrow: false,
      includeCrsLabel: false,
      includeLegend: false,
    });
    expect(layout.mapArea.width).toBeGreaterThanOrEqual(0);
    expect(layout.mapArea.height).toBeGreaterThanOrEqual(0);
  });
});

describe('formatCrsLabel — projection-aware caption', () => {
  it('formats EPSG + name together', () => {
    expect(
      formatCrsLabel({ epsg: 26918, name: 'NAD83 / UTM zone 18N' }),
    ).toBe('EPSG:26918 · NAD83 / UTM zone 18N');
  });

  it('drops redundant EPSG name', () => {
    expect(formatCrsLabel({ epsg: 26918, name: 'EPSG:26918' })).toBe('EPSG:26918');
  });

  it('returns "Local coordinates" for local kind', () => {
    expect(formatCrsLabel({ kind: 'local' })).toBe('Local coordinates');
  });

  it('returns "CRS unknown" for unknown kind', () => {
    expect(formatCrsLabel({ kind: 'unknown' })).toBe('CRS unknown');
  });

  it('falls back to "CRS pending" when only kind is known', () => {
    expect(formatCrsLabel({ kind: 'projected' })).toBe('CRS pending');
  });

  it('handles a name-only input', () => {
    expect(formatCrsLabel({ name: 'WGS 84' })).toBe('WGS 84');
  });
});
