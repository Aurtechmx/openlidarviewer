/**
 * derivedLayerReceipt.test.ts
 *
 * The receipt a DERIVED LAYER carries, so "what produced this, and was the
 * software allowed to claim it" travels with the layer rather than only with an
 * export. The load-bearing property is the digest's REPRODUCIBILITY: the
 * record's fingerprint covers scientific content only — not build, not time —
 * so two runs over the same data agree, while a run over different data does
 * not. A digest that drifted with the clock would identify nothing.
 */

import { describe, it, expect } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import {
  buildDerivedLayerReceipt,
  derivedLayerReceiptDigest,
  derivedLayerReceiptJson,
  derivedLayerReceiptText,
} from '../src/science/derivedLayerReceipt';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

function hill(scale = 8): TerrainPoint[] {
  const pts: TerrainPoint[] = [];
  for (let x = 0; x <= 50; x++) {
    for (let y = 0; y <= 50; y++) {
      const dx = x - 25;
      const dy = y - 25;
      pts.push({ x, y, z: scale * Math.exp(-(dx * dx + dy * dy) / 400) });
    }
  }
  return pts;
}

const OPTS = { cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703' } as const;
const AT = '2026-01-01T00:00:00.000Z';

describe('buildDerivedLayerReceipt', () => {
  const result = analyseContours(hill(), OPTS);
  const receipt = buildDerivedLayerReceipt({ result, generatedAt: AT });

  it('carries the run identity a reader needs', () => {
    expect(receipt.kind).toBeTruthy();
    expect(receipt.digest).toBeTruthy();
    expect(receipt.methods.length).toBeGreaterThan(0);
    expect(['validated', 'exploratory']).toContain(receipt.evidenceGrade);
  });

  it('reports the resolved CRS honesty rather than assuming it', () => {
    expect(receipt.crs.horizontal).toContain('32610');
    expect(receipt.crs.horizontalKnown).toBe(true);
  });

  it('claims NO export authorization — a layer is not a gated file', () => {
    expect(receipt.authorization).toBeNull();
  });

  it('carries an authorization only when one is genuinely supplied', () => {
    const gated = buildDerivedLayerReceipt({
      result, generatedAt: AT, authorizationGrantedFrom: 'process-gate:ready',
    });
    expect(gated.authorization).toBe('process-gate:ready');
  });
});

describe('derived-layer receipt digest — reproducibility', () => {
  it('is IDENTICAL for two runs over the same data', () => {
    const a = buildDerivedLayerReceipt({ result: analyseContours(hill(), OPTS), generatedAt: AT });
    const b = buildDerivedLayerReceipt({ result: analyseContours(hill(), OPTS), generatedAt: AT });
    expect(derivedLayerReceiptDigest(b)).toBe(derivedLayerReceiptDigest(a));
  });

  it('does NOT drift with the clock — the fingerprint excludes time', () => {
    const result = analyseContours(hill(), OPTS);
    const early = buildDerivedLayerReceipt({ result, generatedAt: '2020-05-05T05:05:05.000Z' });
    const late = buildDerivedLayerReceipt({ result, generatedAt: '2031-11-11T11:11:11.000Z' });
    expect(late.digest).toBe(early.digest);
    // The timestamp is still reported — it is a display field, not identity.
    expect(late.generatedAt).not.toBe(early.generatedAt);
  });

  it('DIFFERS when the terrain differs — it identifies this run, not any run', () => {
    const flat = buildDerivedLayerReceipt({ result: analyseContours(hill(1), OPTS), generatedAt: AT });
    const steep = buildDerivedLayerReceipt({ result: analyseContours(hill(30), OPTS), generatedAt: AT });
    expect(steep.digest).not.toBe(flat.digest);
  });
});

describe('derived-layer receipt rendering', () => {
  const receipt = buildDerivedLayerReceipt({ result: analyseContours(hill(), OPTS), generatedAt: AT });

  it('serialises to canonical JSON that round-trips', () => {
    const json = derivedLayerReceiptJson(receipt);
    const back = JSON.parse(json) as { digest: string };
    expect(back.digest).toBe(receipt.digest);
    // Canonical: the same receipt always produces byte-identical JSON.
    expect(derivedLayerReceiptJson(receipt)).toBe(json);
  });

  it('renders readable text that names the run and its digest', () => {
    const text = derivedLayerReceiptText(receipt);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain(receipt.digest);
  });
});
