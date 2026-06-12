/**
 * terrainProducts.test.ts — the Terrain Products VIEW over the assessment.
 *
 * The contract under test is "no new logic": every status must be the
 * workflow row's grade renamed (good → Ready, caution → Preview, blocked →
 * Blocked) and every reason must be SELECTED by the readiness engine's own
 * productReasonFor among strings the assessment engines already minted —
 * Ready rows carry NO reason (a ready product needs no excuse); non-ready
 * rows carry the most specific signal in full (the figure-quoting surface
 * line, the georef-gap export reason, or the workflow note as a fallback).
 * Fixtures are hand-built; expectations are read straight off the mapping
 * table in terrainProducts.ts and the selection rules in readinessEngine.ts.
 */

import { describe, it, expect } from 'vitest';
import { terrainProducts } from '../src/terrain/contour/terrainProducts';
import { recommendedWorkflows } from '../src/terrain/contour/recommendedWorkflow';
import { productReasonFor } from '../src/terrain/quality/readinessEngine';
import type { TerrainAssessment } from '../src/terrain/contour/terrainAssessment';

/** A hand-built assessment — only the fields the view reads carry meaning. */
function assessment(over: Partial<TerrainAssessment>): TerrainAssessment {
  return {
    status: 'Good',
    exportReadiness: 'Ready',
    exportReason: '',
    score: 84,
    scoreKnown: true,
    reason: 'Dense, well-covered surface.',
    bestFor: 'contours',
    useCaution: '',
    notRecommendedFor: '',
    supportingMetrics: [],
    ...over,
  };
}

describe('terrainProducts', () => {
  it('an all-good assessment maps every product to Ready ✓ with NO reason', () => {
    const a = assessment({});
    const products = terrainProducts(a, recommendedWorkflows(a));
    expect(products.map((p) => p.label)).toEqual([
      'Profiles',
      'Measurements',
      'Terrain review',
      'DTM/DEM export',
      'Contours',
      'Map sheet',
    ]);
    for (const p of products) {
      expect(p.statusWord).toBe('Ready');
      expect(p.status).toBe('ready');
      expect(p.glyph).toBe('✓');
      // Ready rows carry no reason — a ready product needs no excuse.
      expect(p.reason).toBeUndefined();
    }
  });

  it('a georef-gapped scan: inspection products Ready (no reason), deliverables Preview ⚠ quoting the exact gap', () => {
    // Surface Good but export capped to Preview — the classic datum-less scan.
    const a = assessment({
      exportReadiness: 'Preview',
      exportReason: 'vertical datum unknown',
    });
    const products = terrainProducts(a, recommendedWorkflows(a));
    const byLabel = new Map(products.map((p) => [p.label, p]));
    for (const label of ['Profiles', 'Measurements', 'Terrain review'] as const) {
      expect(byLabel.get(label)!.statusWord).toBe('Ready');
      expect(byLabel.get(label)!.reason).toBeUndefined();
    }
    for (const label of ['DTM/DEM export', 'Contours', 'Map sheet'] as const) {
      const p = byLabel.get(label)!;
      expect(p.statusWord).toBe('Preview');
      expect(p.status).toBe('preview');
      expect(p.glyph).toBe('⚠');
      // More specific than the generic workflow note ("georeferencing
      // incomplete"): the engine's export reason names the exact gap.
      expect(p.reason).toBe('vertical datum unknown');
    }
  });

  it('a sub-Good surface: caution rows quote the figure-bearing surface line, in full', () => {
    // The assessment's own reason — the string that quotes the measured
    // figures. Both classes must carry it whole (no truncation upstream).
    const surfaceLine =
      'Insufficient quality for reliable terrain products — 72% of the surface is interpolated and ground returns are sparse.';
    const a = assessment({
      status: 'Limited',
      exportReadiness: 'Preview',
      exportReason: 'surface quality is below export grade — validate before hand-off',
      reason: surfaceLine,
    });
    const products = terrainProducts(a, recommendedWorkflows(a));
    for (const p of products) {
      expect(p.statusWord).toBe('Preview');
      // The figure-quoting surface line wins over both the generic note
      // ("preview only — additional validation recommended") and the unquantified
      // export framing — and arrives byte-identical, never shortened.
      expect(p.reason).toBe(surfaceLine);
    }
  });

  it('a blocked surface: everything Blocked ✕, every row quoting the gate sentence', () => {
    const a = assessment({
      status: 'Blocked',
      exportReadiness: 'Blocked',
      exportReason: 'quality gate blocked the surface',
      reason: 'Too little coverage to form a surface.',
    });
    const products = terrainProducts(a, recommendedWorkflows(a));
    for (const p of products) {
      expect(p.statusWord).toBe('Blocked');
      expect(p.glyph).toBe('✕');
      // The gate's own words ARE the export story (deriveReadiness quotes the
      // surface reason verbatim when blocked) — more specific than the
      // workflow note "quality gate stopped this surface".
      expect(p.reason).toBe('Too little coverage to form a surface.');
    }
  });

  it('deliverable fallback chain: exportReason, then the workflow note, when richer strings are empty', () => {
    // Synthetic: a caution deliverable on a Good surface with no exportReason
    // (not produced by today's engine, but the view must stay honest if one
    // appears) — only the row's own note remains.
    const a = assessment({ exportReason: '' });
    const noteOnly = terrainProducts(a, [
      { label: 'DEM export', status: 'caution', note: 'georeferencing incomplete' },
    ]);
    expect(noteOnly[0].reason).toBe('georeferencing incomplete');

    // With an exportReason present it wins over the note.
    const b = assessment({ exportReason: 'vertical datum unknown' });
    const withReason = terrainProducts(b, [
      { label: 'DEM export', status: 'caution', note: 'georeferencing incomplete' },
    ]);
    expect(withReason[0].label).toBe('DTM/DEM export');
    expect(withReason[0].reason).toBe('vertical datum unknown');
  });

  it('the per-row reason IS the engine selection (productReasonFor), never a local rule', () => {
    const a = assessment({
      status: 'Limited',
      exportReadiness: 'Preview',
      exportReason: 'surface quality is below export grade — validate before hand-off',
      reason: 'Insufficient quality for reliable terrain products — 61% of the grid has no data.',
    });
    const workflows = recommendedWorkflows(a);
    const products = terrainProducts(a, workflows);
    for (let i = 0; i < workflows.length; i++) {
      const w = workflows[i];
      const expected = productReasonFor({
        status: w.status,
        productClass: ['DEM export', 'Contour generation', 'Map sheet (PDF)'].includes(w.label)
          ? 'deliverable'
          : 'inspection',
        surfaceTier: a.status,
        surfaceReason: a.reason,
        exportReason: a.exportReason,
        ...(w.note != null ? { note: w.note } : {}),
      });
      expect(products[i].reason).toBe(expected);
    }
  });

  it('an unmapped workflow keeps its own label instead of vanishing', () => {
    const a = assessment({});
    const products = terrainProducts(a, [{ label: 'Future workflow', status: 'good' }]);
    expect(products[0].label).toBe('Future workflow');
  });
});
