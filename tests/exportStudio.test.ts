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

import { test, expect, vi } from 'vitest';
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
  buildScanReport,
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

test('the default registry pre-registers every visible exporter mode', () => {
  // Five modes whose output matches their name: orthographic-rgb,
  // height-map, intensity, classification, normal. Depth and contour are
  // intentionally unregistered until their true implementations land.
  expect(defaultExportRegistry.size).toBe(5);
  expect(defaultExportRegistry.has('orthographic-rgb')).toBe(true);
  expect(defaultExportRegistry.has('height-map')).toBe(true);
  expect(defaultExportRegistry.has('intensity')).toBe(true);
  expect(defaultExportRegistry.has('classification')).toBe(true);
  expect(defaultExportRegistry.has('normal')).toBe(true);
  // Held back: their stub implementations produced an elevation raster
  // (same as Height Map), not the camera-relative depth raster or
  // marching-squares contour lines their names imply.
  expect(defaultExportRegistry.has('depth')).toBe(false);
  expect(defaultExportRegistry.has('contour')).toBe(false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scan-report card — class-scope row (escape-hatch closure)
// ─────────────────────────────────────────────────────────────────────────────

test('buildScanReport: no class filter ⇒ card is byte-identical to the unstamped card', () => {
  const adapter = stubAdapter({ sourceName: 'scope-fixture', sourcePointCount: 4 });
  const base = buildScanReport('Height Map', adapter);
  // Absent, empty, and whitespace-only stamps all mean "no active filter".
  // Footer carries a timestamp, so compare only the scope-bearing rows.
  const rowsOf = (stamp?: string) =>
    JSON.stringify(buildScanReport('Height Map', adapter, [], stamp).rows);
  expect(rowsOf(undefined)).toBe(JSON.stringify(base.rows));
  expect(rowsOf('')).toBe(JSON.stringify(base.rows));
  expect(rowsOf('   ')).toBe(JSON.stringify(base.rows));
  // No 'Class filter' row leaked into the default card.
  expect(base.rows.find((r) => r.label === 'Class filter')).toBeUndefined();
});

test('buildScanReport: active class filter ⇒ appends a Class filter row', () => {
  const adapter = stubAdapter({ sourceName: 'scope-fixture', sourcePointCount: 4 });
  const report = buildScanReport(
    'Height Map',
    adapter,
    [],
    'Ground + Building · 2 of 5 classes',
  );
  const row = report.rows.find((r) => r.label === 'Class filter');
  expect(row).toBeDefined();
  expect(row?.value).toBe('Ground + Building · 2 of 5 classes');
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

test('orthographicRgbExporter is available only with a real scene AABB', () => {
  expect(orthographicRgbExporter.mode).toBe('orthographic-rgb');
  expect(orthographicRgbExporter.label).toBe('Orthographic RGB');
  // Gated like the other image exporters: a real AABB → available; no scene
  // (e.g. a not-yet-decoded streaming cloud) → unavailable, so it can't snapshot
  // an empty frame and ship a blank PNG.
  expect(orthographicRgbExporter.isAvailable(stubContext(stubAdapter({})))).toBe(true);
  expect(orthographicRgbExporter.isAvailable(stubContext(stubAdapter({ aabb: null })))).toBe(false);
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
// Georeferenced ortho path (v0.4.5, workplan C4) — world-file threading
// ─────────────────────────────────────────────────────────────────────────────

import { shouldExportGeoreferencedOrtho } from '../src/export';

/** Stub adapter with the georef hooks wired to fixed values. */
function georefAdapter(opts: {
  worldOrigin?: { x: number; y: number } | null;
  wkt?: string | null;
  aabb?: readonly [number, number, number, number, number, number] | null;
  framed?: boolean;
  framedReturnsNull?: boolean;
}): ExportSceneAdapter & { framedCalls: Array<{ widthPx?: number }> } {
  const base = stubAdapter({ aabb: opts.aabb });
  const framedCalls: Array<{ widthPx?: number }> = [];
  return {
    ...base,
    framedCalls,
    georefContext: () => ({
      worldOrigin: opts.worldOrigin ?? null,
      wkt: opts.wkt ?? null,
    }),
    ...(opts.framed === false
      ? {}
      : {
          framedTopDownSnapshot: async (o: { widthPx?: number }) => {
            framedCalls.push(o);
            if (opts.framedReturnsNull) return null;
            // Hand-computed fixture: AABB [0,0,0,10,10,5] → footprint 10 × 10
            // → at widthPx 200 the height is 200 (square footprint).
            return {
              blob: new Blob(['png'], { type: 'image/png' }),
              widthPx: o.widthPx ?? 2048,
              heightPx: o.widthPx ?? 2048,
              extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
            };
          },
        }),
  };
}

test('shouldExportGeoreferencedOrtho: all four gates must hold', () => {
  const origin = { x: 500_000, y: 4_000_000 };
  const wkt = 'PROJCS["test"]';
  // Happy path.
  expect(
    shouldExportGeoreferencedOrtho(georefAdapter({ worldOrigin: origin, wkt }), ''),
  ).toBe(true);
  // No framed hook (older host / plain stub).
  expect(
    shouldExportGeoreferencedOrtho(
      georefAdapter({ worldOrigin: origin, wkt, framed: false }),
      '',
    ),
  ).toBe(false);
  // No cloud loaded.
  expect(
    shouldExportGeoreferencedOrtho(
      georefAdapter({ worldOrigin: origin, wkt, aabb: null }),
      '',
    ),
  ).toBe(false);
  // Missing world origin / missing or blank WKT — the .prj honesty gate.
  expect(
    shouldExportGeoreferencedOrtho(georefAdapter({ worldOrigin: null, wkt }), ''),
  ).toBe(false);
  expect(
    shouldExportGeoreferencedOrtho(georefAdapter({ worldOrigin: origin, wkt: null }), ''),
  ).toBe(false);
  expect(
    shouldExportGeoreferencedOrtho(georefAdapter({ worldOrigin: origin, wkt: '   ' }), ''),
  ).toBe(false);
  // Active class filter — the banner contract wins; stays a view capture.
  expect(
    shouldExportGeoreferencedOrtho(
      georefAdapter({ worldOrigin: origin, wkt }),
      'Ground + Building · 2 of 5 classes',
    ),
  ).toBe(false);
  // A plain stub without georefContext at all.
  expect(shouldExportGeoreferencedOrtho(stubAdapter({}), '')).toBe(false);
});

test('orthographic-rgb render: georeferenced path returns worldFile data verbatim', async () => {
  const origin = { x: 500_000, y: 4_000_000 };
  const adapter = georefAdapter({ worldOrigin: origin, wkt: '  PROJCS["test"]  ' });
  const ctx = stubContext(adapter);
  const result = await orthographicRgbExporter.render(ctx, { width: 200 });
  expect(adapter.framedCalls).toEqual([{ widthPx: 200 }]);
  expect(result.mode).toBe('orthographic-rgb');
  expect(result.width).toBe(200);
  expect(result.height).toBe(200);
  expect(result.worldFile).toBeDefined();
  expect(result.worldFile?.extent).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  expect(result.worldFile?.widthPx).toBe(200);
  expect(result.worldFile?.heightPx).toBe(200);
  expect(result.worldFile?.worldOrigin).toEqual(origin);
  // WKT is trimmed before it travels — the .prj must not carry padding.
  expect(result.worldFile?.wkt).toBe('PROJCS["test"]');
  expect(result.metadata?.framing).toBe('top-down orthographic');
});

test('orthographic-rgb render: worldFile feeds buildStudioPngPackage end-to-end', async () => {
  // The same threading main.ts performs: exporter result → zip package.
  const { buildStudioPngPackage } = await import('../src/render/export/pngWorldFile');
  const adapter = georefAdapter({
    worldOrigin: { x: 100, y: 200 },
    wkt: 'PROJCS["x"]',
  });
  const result = await orthographicRgbExporter.render(stubContext(adapter), { width: 200 });
  const wf = result.worldFile!;
  const pkg = buildStudioPngPackage({
    basename: 'scan-orthographic-rgb',
    png: new Uint8Array([1, 2, 3]),
    extent: wf.extent,
    widthPx: wf.widthPx,
    heightPx: wf.heightPx,
    worldOrigin: wf.worldOrigin,
    wkt: wf.wkt,
  });
  expect(pkg).not.toBeNull();
  expect(pkg?.georeferenced).toBe(true);
  expect(pkg?.filename).toBe('scan-orthographic-rgb.zip');
});

test('orthographic-rgb render: a null framed render falls back to the view capture', async () => {
  // framedTopDownSnapshot returning null (device hiccup) must not fail the
  // export — it falls through to the WYSIWYG snapshot path, whose product
  // carries NO worldFile. The fallback path composes the scan-report card
  // through canvas APIs unavailable in Node, so we assert the fallthrough by
  // the snapshot() call + the eventual (expected) canvas error, not by blob.
  let snapshotCalled = false;
  const adapter = georefAdapter({
    worldOrigin: { x: 1, y: 2 },
    wkt: 'PROJCS["x"]',
    framedReturnsNull: true,
  });
  const orig = adapter.snapshot.bind(adapter);
  adapter.snapshot = async (o) => {
    snapshotCalled = true;
    return orig(o);
  };
  // The composite-skip announcement on console.warn is this fixture's
  // expected behaviour (Node has no Image) — silenced; the assertions read
  // the adapter call log, not the console.
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await orthographicRgbExporter.render(stubContext(adapter), {}).catch(() => {
    /* Node has no Image/canvas for the report-card composition — fine. */
  });
  expect(adapter.framedCalls.length).toBe(1);
  expect(snapshotCalled).toBe(true);
  warnSpy.mockRestore();
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

// — Default registry list reflects the visible Studio surface ----------------

test('every visible exporter mode appears in the default registry list', () => {
  const modes = defaultExportRegistry.list().map((f) => f.mode);
  expect(modes).toContain('orthographic-rgb');
  expect(modes).toContain('height-map');
  expect(modes).toContain('intensity');
  expect(modes).toContain('classification');
  expect(modes).toContain('normal');
  // Depth + contour are intentionally absent from the visible surface.
  expect(modes).not.toContain('depth');
  expect(modes).not.toContain('contour');
});

// — Presets cover only modes whose output matches their name -----------------

test('EXPORT_PRESETS only includes presets for the visible Studio modes', () => {
  const ids = EXPORT_PRESETS.map((p) => p.id);
  // The presets the Studio ships today.
  expect(ids).toContain('terrain-review');
  expect(ids).toContain('qa-inspection');
  expect(ids).toContain('classification-review');
  expect(ids).toContain('technical-report');
  expect(ids).toContain('intensity-scan');
  expect(ids).toContain('normal-qa');
  // The depth + contour presets are held back alongside their modes.
  expect(ids).not.toContain('depth-ml');
  expect(ids).not.toContain('contour-review');
});

test('every preset references a mode that is actually registered', () => {
  for (const preset of EXPORT_PRESETS) {
    expect(defaultExportRegistry.has(preset.mode)).toBe(true);
  }
});

// — Preset honesty: never advertise what the pipeline cannot deliver --------

test('no preset requests or advertises transparent output', () => {
  // The live renderer is constructed with alpha:false, so a transparent
  // export is IMPOSSIBLE without an offscreen render-target path that does
  // not exist yet. Presets that claimed "transparent background" shipped an
  // opaque PNG — an honesty bug. Until the render-target path lands, no
  // preset may set the flag or mention transparency in its description.
  for (const preset of EXPORT_PRESETS) {
    expect(preset.options.transparent, `${preset.id} sets transparent`).not.toBe(true);
    expect(preset.description, `${preset.id} advertises transparency`).not.toMatch(/transparent/i);
  }
});

test('no preset sets a background colour — nothing in the pipeline reads it', () => {
  // `options.background` has zero consumers: the offscreen re-render and the
  // snapshot copy both ship pixels cleared to the scene's own background, so
  // a preset that sets a colour makes exactly the promise-the-pixels-ignore
  // mistake the transparent flag made. The field survives on
  // CommonExportOptions for API stability; presets must not touch it until a
  // capture path actually applies the colour.
  for (const preset of EXPORT_PRESETS) {
    expect(preset.options.background, `${preset.id} sets background`).toBeUndefined();
  }
});

test('presets that request an explicit size keep the overlay bakes off', () => {
  // An explicit width/height routes the export through the true offscreen
  // re-render (adapter.renderFigure), which is a DIRECT render — measurement
  // and annotation overlays cannot be baked on that path yet. A preset that
  // combined both would silently drop the overlays it promised, so the two
  // capabilities are mutually exclusive at the preset level.
  for (const preset of EXPORT_PRESETS) {
    const wantsExplicitSize =
      typeof preset.options.width === 'number' || typeof preset.options.height === 'number';
    if (!wantsExplicitSize) continue;
    expect(preset.options.includeAnnotations, `${preset.id} bakes annotations`).toBe(false);
    expect(preset.options.includeMeasurements, `${preset.id} bakes measurements`).toBe(false);
  }
});
