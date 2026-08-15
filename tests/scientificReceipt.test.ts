import { describe, it, expect } from 'vitest';
import { buildScientificAnalysisRecord } from '../src/science/scientificAnalysisRecord';
import { buildScientificReceipt, receiptToJson, renderReceiptText } from '../src/science/scientificReceipt';

function record() {
  return buildScientificAnalysisRecord({
    kind: 'terrain-dtm',
    source: 'Flight_2026.laz',
    crs: {
      horizontal: 'WGS 84 / UTM 10N',
      horizontalKnown: true,
      verticalDatum: 'NAVD88',
      verticalDatumKnown: true,
      linearUnit: 'metre',
    },
    methodIds: ['olv.ground.smrf', 'olv.validation.holdout-rmse'],
    evidenceExploratory: false,
    summary: { points: 48239117, gridCellM: 0.25, holdoutRmseM: 0.031 },
    generatedAt: '2026-08-15T14:22:00.000Z',
  });
}

describe('scientificReceipt', () => {
  it('derives the receipt from a record and the authorization it ran under', () => {
    const r = buildScientificReceipt(record(), { authorizationGrantedFrom: 'GROUND_TRUSTED' });
    expect(r.kind).toBe('terrain-dtm');
    expect(r.source).toBe('Flight_2026.laz');
    expect(r.crs.linearUnit).toBe('metre');
    expect(r.evidenceGrade).toBe('validated');
    expect(r.authorization).toBe('GROUND_TRUSTED');
    expect(r.methods.length).toBe(2);
    expect(r.summary.holdoutRmseM).toBe(0.031);
    expect(r.digest).toBe(record().contentHash);
  });

  it('marks an exploratory run and omits authorization when not gated', () => {
    const r = buildScientificReceipt(
      buildScientificAnalysisRecord({ ...recordInput(), evidenceExploratory: true }),
    );
    expect(r.evidenceGrade).toBe('exploratory');
    expect(r.authorization).toBeNull();
  });

  it('serialises stably and renders the headline fields as text', () => {
    const r = buildScientificReceipt(record(), { authorizationGrantedFrom: 'GROUND_TRUSTED' });
    expect(receiptToJson(r)).toBe(receiptToJson(buildScientificReceipt(record(), { authorizationGrantedFrom: 'GROUND_TRUSTED' })));
    const text = renderReceiptText(r);
    expect(text).toContain('terrain-dtm');
    expect(text).toContain('Flight_2026.laz');
    expect(text).toContain('holdoutRmseM');
    expect(text).toContain('Authorization GROUND_TRUSTED');
  });
});

function recordInput() {
  return {
    kind: 'terrain-dtm',
    crs: {
      horizontal: 'not georeferenced',
      horizontalKnown: false,
      verticalDatum: 'unknown',
      verticalDatumKnown: false,
    },
    methodIds: ['olv.ground.smrf'],
    evidenceExploratory: false,
    summary: { points: 1000 },
    generatedAt: '2026-08-15T14:22:00.000Z',
  };
}
