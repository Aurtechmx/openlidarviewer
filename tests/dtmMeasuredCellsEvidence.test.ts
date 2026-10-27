import { describe, expect, it } from 'vitest';
import {
  STUDIED_DTM_MEDIAN_SETS,
  dtmCellsEvidenceText,
  dtmMeasuredParameterSet,
  resolveEvidence,
} from '../src/validation/scopedEvidence';
import { EVIDENCE_REGISTRY } from '../src/validation/evidenceRegistry';

const at = (cellSizeM: number) => ({ cellSizeM, origin: 'data-minimum' as const });

describe('live DTM evidence by cell class and grid', () => {
  it('every studied grid is in the DTM claim scope', () => {
    for (const s of STUDIED_DTM_MEDIAN_SETS) {
      expect(EVIDENCE_REGISTRY['DTM'].scopedParameterSets).toContain(s.parameterSetId);
    }
  });

  it('measured cells on a studied cell size with the data-minimum origin resolve to E4', () => {
    const r = resolveEvidence('DTM', { cells: 'measured', dtmGrid: at(0.5) });
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    // E4 is short of the E5 the DTM requires, so the state stays exploratory.
    expect(r.resolutionState).toBe('exploratory');
    expect(dtmMeasuredParameterSet(at(2 + 1e-12))).toBe('PS-DTM-MEDIAN-CELL2-ORIGINMIN');
  });

  it('an unstudied cell size is not covered, measured cells included', () => {
    const r = resolveEvidence('DTM', { cells: 'measured', dtmGrid: at(0.3) });
    expect(r.effectiveEvidence).toBeNull();
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
    expect(dtmCellsEvidenceText(at(0.3))).toMatch(/^measured cells not covered/);
  });

  it('the default 1 m grid with the data-minimum origin resolves to E4 (protocol v3)', () => {
    expect(dtmMeasuredParameterSet(at(1))).toBe('PS-DTM-MEDIAN-CELL1-ORIGINMIN');
    expect(resolveEvidence('DTM', { cells: 'measured', dtmGrid: at(1) }).effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
  });

  it('1 m with any other origin rule maps to the not-studied set, never to a data-minimum set', () => {
    // The v1 1 m study used origin (0, 0); the live path never builds that grid,
    // and a grid stated as another rule must not borrow the data-minimum study.
    const other = { cellSizeM: 1, origin: 'other' as const };
    expect(dtmMeasuredParameterSet(other)).toBe('PS-DTM-MEDIAN-NOT-STUDIED');
    expect(resolveEvidence('DTM', { cells: 'measured', dtmGrid: other }).effectiveEvidence).toBeNull();
  });

  it('the live path states the data-minimum origin for the grid the run used', async () => {
    const { liveDtmGridRule } = await import('../src/validation/scopedEvidence');
    expect(liveDtmGridRule({ cellSizeM: 1 })).toEqual({ cellSizeM: 1, origin: 'data-minimum' });
  });

  it('a studied size with another origin rule is not covered', () => {
    const r = resolveEvidence('DTM', { cells: 'measured', dtmGrid: { cellSizeM: 0.5, origin: 'other' } });
    expect(r.effectiveEvidence).toBeNull();
  });

  it('measured cells with no grid stated are not covered', () => {
    expect(resolveEvidence('DTM', { cells: 'measured' }).effectiveEvidence).toBeNull();
  });

  it('filled cells stay not covered and inherit no level', () => {
    const r = resolveEvidence('DTM', { cells: 'filled', dtmGrid: at(0.5) });
    expect(r.effectiveEvidence).toBeNull();
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
    expect(r.applicabilityVerdict).toMatch(/not covered/i);
  });

  it('a whole-product DTM with no cell class stays not covered', () => {
    expect(resolveEvidence('DTM').effectiveEvidence).toBeNull();
  });

  it('an explicit parameter set wins over the cell class', () => {
    const r = resolveEvidence('DTM', { cells: 'measured', dtmGrid: at(0.5), parameterSetId: 'PS-DTM-LIVE-MEDIAN-FILL' });
    expect(r.effectiveEvidence).toBeNull();
  });

  it('the shared wording names measured cells on a studied grid and leaves filled cells not covered', () => {
    const text = dtmCellsEvidenceText(at(5));
    expect(text).toMatch(/^E4 .* on measured cells/);
    expect(text).toMatch(/filled cells not covered/);
  });
});

describe('surfaces that show DTM evidence pass the run grid', () => {
  const resultAt = (cellSizeM: number) => ({ dtm: { cellSizeM } });

  it('the DEM package evidence contract', async () => {
    const { renderEvidenceContract } = await import('../src/terrain/export/demPackage');
    const { buildEvidenceContractView } = await import('../src/validation/evidenceBoundaryInspector');
    const view = buildEvidenceContractView('DTM');
    expect(renderEvidenceContract(view, at(0.25)).join('\n')).toMatch(/Effective\s+E4 .*measured cells/);
    expect(renderEvidenceContract(view, at(0.3)).join('\n')).toMatch(/Effective\s+measured cells not covered/);
    expect(renderEvidenceContract(view).join('\n')).toMatch(/Effective\s+measured cells not covered/);
  });

  it('the export evidence gate note', async () => {
    const { EVIDENCE_GATE_NOTE } = await import('../src/terrain/export/exportProvenance');
    expect(EVIDENCE_GATE_NOTE).toMatch(/measured cells/);
  });

  it('the terrain report DTM row', async () => {
    const { dtmNotCovered } = await import('../src/terrain/export/terrainReportContent');
    expect(dtmNotCovered(resultAt(2) as never)).toMatch(/^E4 .*measured cells/);
    expect(dtmNotCovered(resultAt(0.3) as never)).toMatch(/^measured cells not covered/);
    expect(dtmNotCovered(resultAt(2) as never)).toMatch(/filled cells not covered/);
  });

  it('the export provenance scoped-evidence line', async () => {
    const { buildExportProvenance, provenanceLines } = await import('../src/terrain/export/exportProvenance');
    const make = (cellSizeM: number) => ({
      dtm: { coverageMode: 'full', crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', cellSizeM },
      model: { crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', intervalM: 1, contourStyle: 'smooth', coverageMode: 'full' },
      cellStatusTally: { measured: 800, interpolated: 150, empty: 50, lowConfidence: 0, edgeRisk: 0, total: 1000 },
      quality: { status: 'Limited', exportReadiness: 'Preview', reasons: [], exportReasons: [] },
      warnings: [], contours: [], labels: [], intervalM: 1,
    }) as never;
    const line = (cellSizeM: number) => provenanceLines(
      buildExportProvenance(make(cellSizeM), { generatedAt: '2026-10-26T00:00:00.000Z', verticalUnitToMetres: 1, evidenceContext: {} }),
    ).find((l) => l.startsWith('Scoped evidence')) ?? '';
    expect(line(0.5)).toMatch(/E4 .*on measured cells/);
    expect(line(0.3)).toMatch(/measured cells not covered/);
  });
});
