/**
 * streamingSpacingLabel.test.ts
 *
 * Label-vs-value regression for the streaming-scan summary's resolution row.
 *
 * COPC metadata `spacing` is a METRIC root-node point spacing (CRS units), so
 * the panel must render it as a distance ("1.20 m"). EPT metadata `span` is a
 * DIMENSIONLESS points-per-tile budget (the octree resolution analogue) that
 * was fed into the SAME bare "Spacing" row, where it read as "128 m" of
 * spacing — a label-vs-value drift. `spacingRowFor` now labels + units each
 * source correctly: a metric "Spacing" for COPC, a "Node budget" in pts/node
 * for EPT.
 */
import { spacingRowFor } from '../src/ui/StreamingPanel';

test('COPC: spacing renders as a metric distance under the "Spacing" label', () => {
  const r = spacingRowFor('copc', 1.2);
  expect(r.label).toBe('Spacing');
  expect(r.value).toBe('1.20 m');
  expect(r.title).toMatch(/CRS/);
});

test('EPT: span renders as a points-per-node budget, NOT a metric spacing', () => {
  const r = spacingRowFor('ept', 128);
  // Crucially NOT labelled "Spacing" and NOT suffixed " m".
  expect(r.label).toBe('Node budget');
  expect(r.value).toBe('~128 pts/node');
  expect(r.value).not.toMatch(/\bm\b/);
  expect(r.title).toMatch(/not a metric spacing/i);
});

test('EPT: a large span never reads as a huge metre distance', () => {
  const r = spacingRowFor('ept', 65536);
  expect(r.value).toBe('~65,536 pts/node');
  expect(r.label).not.toBe('Spacing');
});

test('undefined format falls back to the metric COPC presentation', () => {
  const r = spacingRowFor(undefined, 0.5);
  expect(r.label).toBe('Spacing');
  expect(r.value).toBe('0.50 m');
});
