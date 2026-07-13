/**
 * exportFigureProvenance.test.ts — contract for the figure-provenance
 * builder (`src/export/figureProvenance.ts`).
 *
 * The builder turns what the app can HONESTLY assert about a rendered figure
 * — build identity, CRS, colour mapping, camera pose, active clip — into the
 * ordered PNG text-chunk entries the metadata writer embeds. Two properties
 * matter enough to pin here:
 *
 *   1. Determinism — same input, same entries, byte for byte. The timestamp
 *      is CALLER-supplied precisely so no `new Date()` sneaks in.
 *   2. Honesty — absent facts produce NO entry. A figure without a CRS must
 *      not carry an `olv:crs` chunk at all, rather than a fabricated or
 *      empty one.
 */

import { test, expect } from 'vitest';
import { buildFigureProvenance, paletteLabelOfOptions } from '../src/export/figureProvenance';
import { encodePngTextChunks, readPngTextChunks } from '../src/export/pngTextChunks';

const BUILD = '0.5.20 (abc1234) · live · built 2026-07-08T18:22:00Z';
const TS = '2026-07-12T10:30:00.000Z';

/** A fully-populated input — every optional fact known. */
function fullInput() {
  return {
    build: BUILD,
    timestamp: TS,
    crs: { name: 'WGS 84 / UTM zone 14N', unit: 'm', epsg: 32614 },
    colorMode: 'elevation',
    palette: 'viridis',
    camera: {
      position: [10, -5.25, 3] as const,
      target: [0, 0, 0] as const,
      fovDeg: 60,
    },
    clip: {
      mode: 'keep-inside' as const,
      min: [-1, -2, 0] as const,
      max: [5, 6, 7.5] as const,
    },
  };
}

test('a fully-known figure produces all seven keywords in canonical order', () => {
  const entries = buildFigureProvenance(fullInput());
  expect(entries.map((e) => e.keyword)).toEqual([
    'Software',
    'Creation Time',
    'olv:build',
    'olv:crs',
    'olv:colormap',
    'olv:camera',
    'olv:clip',
  ]);
});

test('Software / Creation Time / olv:build carry the expected values', () => {
  const entries = buildFigureProvenance(fullInput());
  const byKeyword = new Map(entries.map((e) => [e.keyword, e.text]));
  expect(byKeyword.get('Software')).toBe('OpenLiDARViewer');
  // The caller supplies the timestamp — the builder must never invent one.
  expect(byKeyword.get('Creation Time')).toBe(TS);
  expect(byKeyword.get('olv:build')).toBe(BUILD);
});

test('the minimal input (build + timestamp only) emits exactly three entries', () => {
  const entries = buildFigureProvenance({ build: BUILD, timestamp: TS });
  expect(entries.map((e) => e.keyword)).toEqual(['Software', 'Creation Time', 'olv:build']);
});

test('explicit nulls behave like absent facts — nothing is fabricated', () => {
  const entries = buildFigureProvenance({
    build: BUILD,
    timestamp: TS,
    crs: null,
    colorMode: null,
    palette: null,
    camera: null,
    clip: null,
  });
  expect(entries.map((e) => e.keyword)).toEqual(['Software', 'Creation Time', 'olv:build']);
});

test('building twice from the same input is deterministic', () => {
  expect(buildFigureProvenance(fullInput())).toEqual(buildFigureProvenance(fullInput()));
});

test('olv:crs formats name, EPSG code, and unit — and omits a missing EPSG', () => {
  const withEpsg = buildFigureProvenance(fullInput());
  expect(withEpsg.find((e) => e.keyword === 'olv:crs')?.text).toBe(
    'WGS 84 / UTM zone 14N (EPSG:32614) · m',
  );

  const noEpsg = buildFigureProvenance({
    build: BUILD,
    timestamp: TS,
    crs: { name: 'Local grid', unit: 'ft' },
  });
  expect(noEpsg.find((e) => e.keyword === 'olv:crs')?.text).toBe('Local grid · ft');
});

test('olv:colormap is the colour mode alone, or mode · palette when a palette is known', () => {
  const modeOnly = buildFigureProvenance({ build: BUILD, timestamp: TS, colorMode: 'rgb' });
  expect(modeOnly.find((e) => e.keyword === 'olv:colormap')?.text).toBe('rgb');

  const withPalette = buildFigureProvenance(fullInput());
  expect(withPalette.find((e) => e.keyword === 'olv:colormap')?.text).toBe('elevation · viridis');

  // A palette WITHOUT a colour mode is not a colour mapping — emit nothing
  // rather than a palette floating free of the mode it modifies.
  const paletteOnly = buildFigureProvenance({ build: BUILD, timestamp: TS, palette: 'viridis' });
  expect(paletteOnly.find((e) => e.keyword === 'olv:colormap')).toBeUndefined();
});

test('olv:camera formats position/target to 3 decimals and fov to 1', () => {
  const entries = buildFigureProvenance(fullInput());
  expect(entries.find((e) => e.keyword === 'olv:camera')?.text).toBe(
    'pos 10.000,-5.250,3.000 · target 0.000,0.000,0.000 · fov 60.0°',
  );
});

test('olv:camera omits the target and fov segments when they are unknown', () => {
  const entries = buildFigureProvenance({
    build: BUILD,
    timestamp: TS,
    camera: { position: [1, 2, 3] },
  });
  expect(entries.find((e) => e.keyword === 'olv:camera')?.text).toBe('pos 1.000,2.000,3.000');
});

test('olv:clip records the mode and both corners to 3 decimals', () => {
  const entries = buildFigureProvenance(fullInput());
  expect(entries.find((e) => e.keyword === 'olv:clip')?.text).toBe(
    'keep-inside · min -1.000,-2.000,0.000 · max 5.000,6.000,7.500',
  );
});

test('every produced entry embeds cleanly as a PNG text chunk (keyword validity)', () => {
  // The keyword set is chosen to satisfy the PNG tEXt keyword rules
  // (printable Latin-1, ≤79 bytes, no edge spaces) — prove it by pushing a
  // full provenance set through the actual writer and reading it back.
  const tinyPng = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0, 58, 126, 155, 85,
    0, 0, 0, 10, 73, 68, 65, 84, 120, 156, 99, 168, 7, 0, 0, 129, 0, 128, 211, 148, 83, 74,
    0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ]);
  const entries = buildFigureProvenance(fullInput());
  const roundTripped = readPngTextChunks(encodePngTextChunks(tinyPng, entries));
  expect(roundTripped).toEqual(entries);
});

// ─────────────────────────────────────────────────────────────────────────────
// paletteLabelOfOptions — the options → palette-label bridge
// ─────────────────────────────────────────────────────────────────────────────

test('paletteLabelOfOptions reads the height-map ramp and the contour palette', () => {
  expect(paletteLabelOfOptions({ ramp: 'terrain' })).toBe('terrain');
  expect(paletteLabelOfOptions({ palette: 'topographic' })).toBe('topographic');
  // `ramp` is the more specific of the two when both appear.
  expect(paletteLabelOfOptions({ ramp: 'heatmap', palette: 'terrain' })).toBe('heatmap');
});

test('paletteLabelOfOptions returns null when no palette-shaped option exists', () => {
  expect(paletteLabelOfOptions({})).toBeNull();
  expect(paletteLabelOfOptions(undefined)).toBeNull();
  expect(paletteLabelOfOptions({ width: 2048 })).toBeNull();
  // Non-string values are not palettes — never stringify them.
  expect(paletteLabelOfOptions({ ramp: 42 })).toBeNull();
});
