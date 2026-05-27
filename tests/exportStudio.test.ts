/**
 * exportStudio.test.ts — v0.3.2 Visual Export Studio unit tests.
 *
 * Three layers covered here:
 *   1. The registry itself — pure data structure, fully testable in Node.
 *   2. Each exporter's `isAvailable` capability contract — pure adapter
 *      query, no rendering needed.
 *   3. The pure helpers — `orthoCameraForPerspective` math + the legend
 *      layout helpers.
 *
 * The actual `render()` calls require a real `WebGPURenderer` + DOM canvas,
 * so those are covered by the live-build smoke test, not here.
 */

import { test, expect } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  ExportRegistry,
  defaultExportRegistry,
  orthographicRgbExporter,
  orthoCameraForPerspective,
  heightMapExporter,
  intensityExporter,
  classificationExporter,
  HEIGHT_MAP_RAMPS,
  HEIGHT_MAP_RESOLUTIONS,
  asprsLabel,
  measureLegend,
  DEFAULT_LEGEND_CODES,
  EXPORT_PRESETS,
  getExportPreset,
} from '../src/export';
import type {
  ExportContext,
  ExportFactory,
  ExportMode,
  ExportSceneAdapter,
} from '../src/export';

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal adapter with the given capability flags + AABB. */
function stubAdapter(opts: {
  hasIntensity?: boolean;
  hasClassification?: boolean;
  hasRgb?: boolean;
  hasNormals?: boolean;
  aabb?: readonly [number, number, number, number, number, number] | null;
  sourceName?: string;
  sourcePointCount?: number;
}): ExportSceneAdapter {
  return {
    setExportColorMode: () => {},
    currentColorMode: () => 'rgb',
    hasRgb: () => opts.hasRgb ?? true,
    hasIntensity: () => opts.hasIntensity ?? false,
    hasClassification: () => opts.hasClassification ?? false,
    hasNormals: () => opts.hasNormals ?? false,
    localBoundsAabb: () => (opts.aabb === undefined ? [0, 0, 0, 10, 10, 5] : opts.aabb),
    // v0.3.2-Studio additions — exporters now delegate the actual render +
    // overlay work to `adapter.snapshot()`, and the scan-report card reads
    // name + point count off the adapter. Tests that only touch
    // `isAvailable` don't drive these, so the stubs are minimal.
    // v0.3.2-Studio: snapshot signature gained inspector + probe flags.
    // The stub doesn't care; just returns an empty Blob for unit-test paths.
    snapshot: async (_opts: {
      measurements: boolean;
      annotations: boolean;
      inspector: boolean;
      probe: boolean;
    }) => new Blob([], { type: 'image/png' }),
    sourceName: () => opts.sourceName ?? 'test-scan',
    sourcePointCount: () => opts.sourcePointCount ?? 1000,
    residentPointCount: () => opts.sourcePointCount ?? 1000,
    // v0.3.2-Georef: the stub returns null by default (most unit tests
    // don't care about CRS).
    crsLabel: () => null,
  };
}

/** Build a stub context using a hand-rolled adapter. */
function stubContext(adapter: ExportSceneAdapter): ExportContext {
  // The exporters' isAvailable contracts only touch `adapter`, so we cast a
  // sparse object here. The rendering path is exercised in the live build.
  return { adapter } as unknown as ExportContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// ExportRegistry
// ─────────────────────────────────────────────────────────────────────────────

test('the registry exposes register/get/has/list/size — round-trip', () => {
  const r = new ExportRegistry();
  expect(r.size).toBe(0);
  expect(r.has('orthographic-rgb')).toBe(false);
  expect(r.get('orthographic-rgb')).toBeUndefined();

  r.register(orthographicRgbExporter);
  expect(r.size).toBe(1);
  expect(r.has('orthographic-rgb')).toBe(true);
  expect(r.get('orthographic-rgb')).toBe(orthographicRgbExporter);
  expect(r.list()).toEqual([orthographicRgbExporter]);
});

test('the registry rejects duplicate registration — bug-catch contract', () => {
  const r = new ExportRegistry();
  r.register(orthographicRgbExporter);
  expect(() => r.register(orthographicRgbExporter)).toThrow(/already registered/i);
});

test('the registry preserves insertion order in list()', () => {
  const r = new ExportRegistry();
  const stub = (mode: ExportMode): ExportFactory => ({
    mode,
    label: mode,
    isAvailable: () => true,
    render: async () => ({ blob: new Blob(), mode, width: 0, height: 0, mimeType: 'image/png' }),
  });
  r.register(stub('height-map'));
  r.register(stub('intensity'));
  r.register(stub('classification'));
  expect(r.list().map((f) => f.mode)).toEqual(['height-map', 'intensity', 'classification']);
});

test('the default registry pre-registers every v0.3.3 mode', () => {
  // v0.3.3 completes the catalogue — seven modes total now:
  // the four v0.3.2 modes plus depth, normal, and contour.
  expect(defaultExportRegistry.size).toBe(7);
  expect(defaultExportRegistry.has('orthographic-rgb')).toBe(true);
  expect(defaultExportRegistry.has('height-map')).toBe(true);
  expect(defaultExportRegistry.has('intensity')).toBe(true);
  expect(defaultExportRegistry.has('classification')).toBe(true);
  expect(defaultExportRegistry.has('depth')).toBe(true);
  expect(defaultExportRegistry.has('normal')).toBe(true);
  expect(defaultExportRegistry.has('contour')).toBe(true);
});

test('availableModes + unavailableModes — capability gating round-trip', () => {
  const ctx = stubContext(stubAdapter({
    hasIntensity: false,
    hasClassification: false,
    aabb: [0, 0, 0, 10, 10, 5],
  }));
  const available = defaultExportRegistry.availableModes(ctx).map((f) => f.mode);
  const unavailable = defaultExportRegistry.unavailableModes(ctx);
  // Orthographic + height-map are always available when AABB exists; intensity
  // + classification are gated by capability.
  expect(available).toContain('orthographic-rgb');
  expect(available).toContain('height-map');
  expect(available).not.toContain('intensity');
  expect(available).not.toContain('classification');
  expect(unavailable.find((u) => u.mode === 'intensity')?.reason).toMatch(/intensity/i);
  expect(unavailable.find((u) => u.mode === 'classification')?.reason).toMatch(/classification/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// OrthographicRgbExporter — isAvailable + math
// ─────────────────────────────────────────────────────────────────────────────

test('orthographicRgbExporter is universally available — every context', () => {
  expect(orthographicRgbExporter.mode).toBe('orthographic-rgb');
  expect(orthographicRgbExporter.label).toBe('Orthographic RGB');
  // isAvailable doesn't reach `adapter`, so any context will do.
  expect(orthographicRgbExporter.isAvailable({} as unknown as ExportContext)).toBe(true);
});

test('orthoCameraForPerspective produces a parallel-projection camera at the same pose', () => {
  const persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  persp.position.set(10, 20, 30);
  persp.lookAt(0, 0, 0);
  persp.updateMatrixWorld();

  const ortho = orthoCameraForPerspective(persp, 100);
  expect(ortho.position.toArray()).toEqual([10, 20, 30]);
  expect(ortho.quaternion.equals(persp.quaternion)).toBe(true);
  const halfH = 100 * Math.tan((60 * Math.PI) / 180 / 2);
  const halfW = halfH * (16 / 9);
  expect(ortho.top).toBeCloseTo(halfH, 5);
  expect(ortho.bottom).toBeCloseTo(-halfH, 5);
  expect(ortho.right).toBeCloseTo(halfW, 5);
  expect(ortho.left).toBeCloseTo(-halfW, 5);
});

test('orthoCameraForPerspective preserves near/far clip planes', () => {
  const persp = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
  const ortho = orthoCameraForPerspective(persp, 50);
  expect(ortho.near).toBe(0.5);
  expect(ortho.far).toBe(5000);
});

test('a larger focal distance produces a wider orthographic frame', () => {
  const persp = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const near = orthoCameraForPerspective(persp, 10);
  const far = orthoCameraForPerspective(persp, 100);
  expect(far.right - far.left).toBeCloseTo((near.right - near.left) * 10, 5);
});

// ─────────────────────────────────────────────────────────────────────────────
// HeightMapExporter — isAvailable + ramps
// ─────────────────────────────────────────────────────────────────────────────

test('heightMapExporter requires a non-degenerate Z extent', () => {
  const flat = stubContext(stubAdapter({ aabb: [0, 0, 5, 10, 10, 5] }));
  expect(heightMapExporter.isAvailable(flat)).toBe(false);
  expect(heightMapExporter.unavailableReason?.(flat)).toMatch(/height range/i);

  const cube = stubContext(stubAdapter({ aabb: [0, 0, 0, 10, 10, 5] }));
  expect(heightMapExporter.isAvailable(cube)).toBe(true);
});

test('heightMapExporter is unavailable when no cloud is loaded', () => {
  const ctx = stubContext(stubAdapter({ aabb: null }));
  expect(heightMapExporter.isAvailable(ctx)).toBe(false);
  expect(heightMapExporter.unavailableReason?.(ctx)).toMatch(/no cloud/i);
});

test('HEIGHT_MAP_RAMPS lists the four supported ramps', () => {
  expect(HEIGHT_MAP_RAMPS).toEqual(['terrain', 'grayscale', 'heatmap', 'topo']);
});

test('HEIGHT_MAP_RESOLUTIONS lists the three default presets', () => {
  expect(HEIGHT_MAP_RESOLUTIONS).toEqual([1024, 2048, 4096]);
});

// ─────────────────────────────────────────────────────────────────────────────
// IntensityExporter — capability gating
// ─────────────────────────────────────────────────────────────────────────────

test('intensityExporter requires intensity to be present', () => {
  const without = stubContext(stubAdapter({ hasIntensity: false }));
  expect(intensityExporter.isAvailable(without)).toBe(false);
  expect(intensityExporter.unavailableReason?.(without)).toMatch(/no intensity channel/i);

  const with_ = stubContext(stubAdapter({ hasIntensity: true }));
  expect(intensityExporter.isAvailable(with_)).toBe(true);
});

test('intensityExporter is unavailable when no cloud is loaded', () => {
  const ctx = stubContext(stubAdapter({ hasIntensity: true, aabb: null }));
  expect(intensityExporter.isAvailable(ctx)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ClassificationExporter — capability gating
// ─────────────────────────────────────────────────────────────────────────────

test('classificationExporter requires classification to be present', () => {
  const without = stubContext(stubAdapter({ hasClassification: false }));
  expect(classificationExporter.isAvailable(without)).toBe(false);
  expect(classificationExporter.unavailableReason?.(without)).toMatch(/no classification channel/i);

  const with_ = stubContext(stubAdapter({ hasClassification: true }));
  expect(classificationExporter.isAvailable(with_)).toBe(true);
});

test('classificationExporter is unavailable when no cloud is loaded', () => {
  const ctx = stubContext(stubAdapter({ hasClassification: true, aabb: null }));
  expect(classificationExporter.isAvailable(ctx)).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ASPRS legend
// ─────────────────────────────────────────────────────────────────────────────

test('asprsLabel returns the standard label for known codes', () => {
  expect(asprsLabel(2)).toBe('Ground');
  expect(asprsLabel(5)).toBe('High vegetation');
  expect(asprsLabel(6)).toBe('Building');
  expect(asprsLabel(9)).toBe('Water');
  expect(asprsLabel(17)).toBe('Bridge deck');
});

test('asprsLabel marks user-defined codes (>= 19) explicitly', () => {
  expect(asprsLabel(42)).toBe('User class 42');
});

test('DEFAULT_LEGEND_CODES includes the high-frequency ASPRS classes', () => {
  // Ground (2), building (6), water (9) at minimum — these are the three
  // any classification map must legend correctly.
  expect(DEFAULT_LEGEND_CODES).toContain(2);
  expect(DEFAULT_LEGEND_CODES).toContain(6);
  expect(DEFAULT_LEGEND_CODES).toContain(9);
});

test('measureLegend returns positive dimensions for a non-empty swatch list', () => {
  const swatches = [
    { color: '#000', label: 'Ground' },
    { color: '#fff', label: 'Building' },
  ];
  const { width, height } = measureLegend(swatches);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// ExportPresets
// ─────────────────────────────────────────────────────────────────────────────

test('EXPORT_PRESETS includes the five v0.3.2 preset bundles', () => {
  const ids = EXPORT_PRESETS.map((p) => p.id);
  expect(ids).toContain('terrain-review');
  expect(ids).toContain('qa-inspection');
  expect(ids).toContain('classification-review');
  expect(ids).toContain('technical-report');
  expect(ids).toContain('intensity-scan');
});

test('getExportPreset returns the matching preset by id', () => {
  const preset = getExportPreset('terrain-review');
  expect(preset).toBeDefined();
  expect(preset?.mode).toBe('height-map');
  expect(getExportPreset('does-not-exist')).toBeUndefined();
});

test('every preset references a mode that exists in the default registry', () => {
  for (const preset of EXPORT_PRESETS) {
    expect(defaultExportRegistry.has(preset.mode)).toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ScanReportRenderer — pure-formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

import { formatInt, formatMetres, formatTimestamp } from '../src/export';

test('formatInt adds locale separators', () => {
  expect(formatInt(1000)).toBe('1,000');
  expect(formatInt(3714345)).toBe('3,714,345');
  expect(formatInt(0)).toBe('0');
});

test('formatMetres scales km / m / cm by magnitude', () => {
  expect(formatMetres(2500)).toBe('2.50 km');
  expect(formatMetres(78.8)).toBe('78.8 m');
  expect(formatMetres(5.05)).toBe('5.05 m');
  expect(formatMetres(0.051)).toBe('5.1 cm');
});

test('formatTimestamp returns the YYYY-MM-DD HH:MM shape', () => {
  // 2026-05-26 22:03 local time — using local Date so this test is
  // timezone-independent by checking the format, not the literal value.
  const d = new Date(2026, 4, 26, 22, 3);
  expect(formatTimestamp(d)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  expect(formatTimestamp(d)).toBe('2026-05-26 22:03');
});

// ─────────────────────────────────────────────────────────────────────────────
// v0.3.3 — Depth + Normal + Contour exporters
// ─────────────────────────────────────────────────────────────────────────────

import {
  depthMapExporter,
  normalMapExporter,
  contourMapExporter,
} from '../src/export';

// — Depth Map ----------------------------------------------------------------

test('depthMapExporter — identity + label', () => {
  expect(depthMapExporter.mode).toBe('depth');
  expect(depthMapExporter.label).toBe('Depth Map');
});

test('depthMapExporter requires a non-degenerate Z extent', () => {
  const flat = stubContext(stubAdapter({ aabb: [0, 0, 5, 10, 10, 5] }));
  expect(depthMapExporter.isAvailable(flat)).toBe(false);
  expect(depthMapExporter.unavailableReason?.(flat)).toMatch(/depth/i);

  const cube = stubContext(stubAdapter({ aabb: [0, 0, 0, 10, 10, 5] }));
  expect(depthMapExporter.isAvailable(cube)).toBe(true);
});

test('depthMapExporter is unavailable when no cloud is loaded', () => {
  const ctx = stubContext(stubAdapter({ aabb: null }));
  expect(depthMapExporter.isAvailable(ctx)).toBe(false);
  expect(depthMapExporter.unavailableReason?.(ctx)).toMatch(/no cloud/i);
});

// — Normal Map ---------------------------------------------------------------

test('normalMapExporter — identity + label', () => {
  expect(normalMapExporter.mode).toBe('normal');
  expect(normalMapExporter.label).toBe('Normal Map');
});

test('normalMapExporter gates on hasNormals — typical LiDAR scans hit the message', () => {
  // Default stub: hasNormals === false. LiDAR captures (COPC / EPT / LAS)
  // never carry normals, so this is the common path.
  const lidar = stubContext(stubAdapter({}));
  expect(normalMapExporter.isAvailable(lidar)).toBe(false);
  expect(normalMapExporter.unavailableReason?.(lidar)).toMatch(/per-point normals/i);

  // Source that does carry normals (PCD / PTX / GLTF case).
  const meshLike = stubContext(stubAdapter({ hasNormals: true }));
  expect(normalMapExporter.isAvailable(meshLike)).toBe(true);
});

// — Contour Map --------------------------------------------------------------

test('contourMapExporter — identity + label', () => {
  expect(contourMapExporter.mode).toBe('contour');
  expect(contourMapExporter.label).toBe('Contour Map');
});

test('contourMapExporter requires at least 10 cm of elevation range', () => {
  const tooFlat = stubContext(stubAdapter({ aabb: [0, 0, 0, 10, 10, 0.05] }));
  expect(contourMapExporter.isAvailable(tooFlat)).toBe(false);
  expect(contourMapExporter.unavailableReason?.(tooFlat)).toMatch(/elevation range/i);

  const lowRelief = stubContext(stubAdapter({ aabb: [0, 0, 0, 10, 10, 0.5] }));
  expect(contourMapExporter.isAvailable(lowRelief)).toBe(true);
});

test('contourMapExporter is unavailable when no cloud is loaded', () => {
  const ctx = stubContext(stubAdapter({ aabb: null }));
  expect(contourMapExporter.isAvailable(ctx)).toBe(false);
});

// — Default registry now covers every v0.3.3 mode ---------------------------

test('every v0.3.3 mode appears in the default registry list', () => {
  const modes = defaultExportRegistry.list().map((f) => f.mode);
  expect(modes).toContain('depth');
  expect(modes).toContain('normal');
  expect(modes).toContain('contour');
});

// — Presets cover the new exporters too ---------------------------------------

test('EXPORT_PRESETS includes the three v0.3.3 presets', () => {
  const ids = EXPORT_PRESETS.map((p) => p.id);
  expect(ids).toContain('depth-ml');
  expect(ids).toContain('normal-qa');
  expect(ids).toContain('contour-review');
});

test('every v0.3.3 preset references a registered mode', () => {
  for (const preset of EXPORT_PRESETS) {
    expect(defaultExportRegistry.has(preset.mode)).toBe(true);
  }
});
