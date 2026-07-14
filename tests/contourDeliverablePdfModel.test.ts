/**
 * contourDeliverablePdfModel.test.ts
 *
 * The premium multipage contour PDF content model (spec §20/§20.7): page count,
 * title-block fields, geometry-role disclosure, watermark⇔exploratory, the
 * blocked-never-polished rule, forbidden-wording detection, and determinism.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContourPdfModel,
  validateContourPdfModel,
  type ContourPdfInput,
  type ContourPdfModel,
} from '../src/terrain/contourStudio/contourDeliverablePdfModel';
import type { ScientificExportDecision } from '../src/export/exportManifest';

const validated: ScientificExportDecision = { status: 'validated', badge: 'Internal validation', caveats: ['Suitability: not survey-grade.'] };
const exploratory: ScientificExportDecision = { status: 'exploratory', badge: 'Exploratory', watermark: 'EXPLORATORY', caveats: ['Suitability: not survey-grade.', 'Metric contour support is not claimed.'] };
const blocked: ScientificExportDecision = { status: 'blocked', reasons: ['no surface'] };

function input(decision: ScientificExportDecision, over: Partial<ContourPdfInput> = {}): ContourPdfInput {
  return {
    title: 'Site A — Contours',
    provenance: {
      software: 'OpenLiDARViewer', softwareVersion: '0.5.9', gitCommit: 'abc123', generated: '2026-07-09T00:00:00Z',
      crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', horizontalUnit: 'metre', verticalUnit: 'metre',
      grid: '0.25 m', methodIds: ['olv.ground.smrf@1', 'olv.contour.generalize.dp@1'], sourceHash: 'deadbeef',
    },
    support: { measuredPct: 83, interpolatedPct: 14, unsupportedPct: 3 },
    validation: { mode: 'Spatial internal', rmseM: 0.09, sampleSize: 1200, independentCheckpoints: false },
    decision,
    geometry: { cartographic: true, analyticalAvailable: true },
    ...over,
  };
}

describe('buildContourPdfModel', () => {
  it('builds the four standard pages with a complete title block', () => {
    const m = buildContourPdfModel(input(validated));
    expect(m.pages.map((p) => p.title)).toEqual(['Contour summary', 'Surface support', 'Validation', 'Method and provenance']);
    expect(validateContourPdfModel(m).problems).toEqual([]);
    const title = m.titleBlock.join('\n');
    expect(title).toContain('OpenLiDARViewer 0.5.9');
    expect(title).toContain('Generated');
    expect(title).toMatch(/not survey-grade/i);
  });

  it('validated model carries no watermark', () => {
    const m = buildContourPdfModel(input(validated));
    expect(m.watermark).toBeNull();
    expect(m.evidenceBadge).toBe('Internal validation only');
  });

  it('exploratory model carries the watermark + badge and still validates', () => {
    const m = buildContourPdfModel(input(exploratory));
    expect(m.watermark).toBe('EXPLORATORY');
    expect(m.evidenceBadge).toBe('Exploratory');
    expect(validateContourPdfModel(m).ok).toBe(true);
    expect(m.pages[0].lines.join(' ')).toMatch(/EXPLORATORY/);
  });

  it('discloses the geometry role on the map page', () => {
    const m = buildContourPdfModel(input(validated));
    expect(m.pages[0].lines.join(' ')).toMatch(/analytical geometry is available/i);
  });

  it('a blocked decision never yields a polished deliverable', () => {
    expect(() => buildContourPdfModel(input(blocked))).toThrow(/blocked/i);
  });

  it('adds the optional standards-traceability page without asserting compliance', () => {
    const m = buildContourPdfModel(input(validated, { standardsTraceability: true }));
    expect(m.pages).toHaveLength(5);
    expect(m.pages[4].title).toBe('Standards traceability');
    expect(validateContourPdfModel(m).ok).toBe(true);
  });

  it('is deterministic for the same input', () => {
    expect(buildContourPdfModel(input(validated))).toEqual(buildContourPdfModel(input(validated)));
  });
});

describe('validateContourPdfModel', () => {
  it('flags forbidden asserted wording', () => {
    const bad: ContourPdfModel = {
      titleBlock: ['T', 'Generated x', 'Evidence: ok', 'not survey-grade'],
      evidenceBadge: 'Internal validation only',
      watermark: null,
      pages: [
        { title: 'Contour map', lines: ['analytical geometry', 'This product is certified accurate.'] },
        { title: 'Surface support', lines: [] },
        { title: 'Validation', lines: [] },
        { title: 'Method and provenance', lines: [] },
      ],
    };
    const r = validateContourPdfModel(bad);
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => /certified/.test(p))).toBe(true);
  });

  it('flags an exploratory badge with no watermark', () => {
    const m: ContourPdfModel = {
      titleBlock: ['T', 'Generated x', 'Evidence: Exploratory', 'not survey-grade'],
      evidenceBadge: 'Exploratory',
      watermark: null,
      pages: [
        { title: 'Contour map', lines: ['cartographic'] },
        { title: 'b', lines: [] }, { title: 'c', lines: [] }, { title: 'd', lines: [] },
      ],
    };
    expect(validateContourPdfModel(m).problems.some((p) => /watermark/.test(p))).toBe(true);
  });
});
