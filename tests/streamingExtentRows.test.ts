/**
 * streamingExtentRows.test.ts
 *
 * Coordinate-integrity guard for the streaming Scan-report's extent block.
 *
 * The panel derives Width/Depth/Height/Density/Spacing from the file header's
 * source-coordinate bounds and a per-CRS metre factor. An unknown-unit CRS
 * carries the inert placeholder `linearUnitToMetres: 1`; consuming it WITHOUT
 * gating on `linearUnit !== 'unknown'` stamps "m" / "pts/m²" onto non-metre
 * data. `streamingExtentRows` fails closed: it only claims metres when the CRS
 * declares a real linear unit, matching the measure tool and lasso.
 */
import { streamingExtentRows } from '../src/analysis/streamingExtentRows';

const header = {
  min: [0, 0, 0] as const,
  max: [1000, 1000, 100] as const,
};

test('metre CRS: converts and labels "m" / "pts/m²" (byte-identical to before)', () => {
  const { unitConfirmed, rows } = streamingExtentRows(
    header,
    { linearUnit: 'metre', linearUnitToMetres: 1 },
    1_000_000,
  );
  expect(unitConfirmed).toBe(true);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  expect(byLabel.Width).toBe('1000.0 m');
  expect(byLabel.Depth).toBe('1000.0 m');
  expect(byLabel.Height).toBe('100.0 m');
  expect(byLabel.Density).toBe('1.0 pts/m²');
  expect(byLabel.Spacing).toBe('1.00 m');
});

test('foot CRS: applies the 0.3048 factor before stamping metres', () => {
  const { unitConfirmed, rows } = streamingExtentRows(
    header,
    { linearUnit: 'foot', linearUnitToMetres: 0.3048, verticalUnitToMetres: 0.3048 },
    1_000_000,
  );
  expect(unitConfirmed).toBe(true);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  // 1000 ft → 304.8 m; a foot cloud must NOT read 1000 m.
  expect(byLabel.Width).toBe('304.8 m');
  expect(byLabel.Height).toBe('30.5 m');
});

test('unknown-unit CRS: does NOT claim metres despite the placeholder factor', () => {
  const { unitConfirmed, rows } = streamingExtentRows(
    header,
    // The leak shape: unknown unit, inert factor 1.
    { linearUnit: 'unknown', linearUnitToMetres: 1 },
    1_000_000,
  );
  expect(unitConfirmed).toBe(false);
  for (const r of rows) {
    // No bare metre / pts-per-square-metre claim anywhere.
    expect(r.value).not.toMatch(/\bm\b/);
    expect(r.value).not.toMatch(/pts\/m²/);
  }
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  expect(byLabel.Width).toBe('1000.0 (source units)');
  expect(byLabel.Density).toBe('1.0 pts/unit²');
  expect(byLabel.Spacing).toBe('1.00 (source units)');
});

test('no CRS resolved (null): fails closed exactly like unknown', () => {
  const { unitConfirmed, rows } = streamingExtentRows(header, null, 1_000_000);
  expect(unitConfirmed).toBe(false);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  expect(byLabel.Width).toBe('1000.0 (source units)');
  expect(byLabel.Width).not.toMatch(/\bm\b/);
});

test('density & spacing rows carry the class-scope flag; extents do not', () => {
  const { rows } = streamingExtentRows(header, { linearUnit: 'metre', linearUnitToMetres: 1 }, 1_000_000);
  const scoped = new Set(rows.filter((r) => r.scoped).map((r) => r.label));
  expect(scoped).toEqual(new Set(['Density', 'Spacing']));
});

test('degenerate footprint: emits extents only, no density/spacing', () => {
  const flat = { min: [0, 0, 0] as const, max: [0, 100, 100] as const };
  const { rows } = streamingExtentRows(flat, { linearUnit: 'metre', linearUnitToMetres: 1 }, 1000);
  expect(rows.map((r) => r.label)).toEqual(['Width', 'Depth', 'Height']);
});
