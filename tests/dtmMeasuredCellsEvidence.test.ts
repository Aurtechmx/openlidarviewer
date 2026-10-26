import { describe, expect, it } from 'vitest';
import {
  LIVE_DTM_CELL_PARAMETER_SET,
  dtmCellsEvidenceText,
  resolveEvidence,
} from '../src/validation/scopedEvidence';
import { EVIDENCE_REGISTRY } from '../src/validation/evidenceRegistry';

describe('live DTM evidence by cell class', () => {
  it('measured cells resolve through the median parameter set to E4', () => {
    expect(LIVE_DTM_CELL_PARAMETER_SET.measured).toBe('PS-DTM-MEDIAN-CELL1-ORIGIN0');
    expect(EVIDENCE_REGISTRY['DTM'].scopedParameterSets).toContain('PS-DTM-MEDIAN-CELL1-ORIGIN0');
    const r = resolveEvidence('DTM', { cells: 'measured' });
    expect(r.effectiveEvidence).toBe('E4_CROSS_IMPLEMENTATION_VALIDATED');
    // E4 is short of the E5 the DTM requires, so the state stays exploratory.
    expect(r.resolutionState).toBe('exploratory');
  });

  it('filled cells stay not covered and inherit no level', () => {
    const r = resolveEvidence('DTM', { cells: 'filled' });
    expect(r.effectiveEvidence).toBeNull();
    expect(r.resolutionState).toBe('external-evidence-out-of-scope');
    expect(r.applicabilityVerdict).toMatch(/not covered/i);
  });

  it('a whole-product DTM with no cell class stays not covered', () => {
    expect(resolveEvidence('DTM').effectiveEvidence).toBeNull();
  });

  it('an explicit parameter set wins over the cell class', () => {
    const r = resolveEvidence('DTM', { cells: 'measured', parameterSetId: 'PS-DTM-LIVE-MEDIAN-FILL' });
    expect(r.effectiveEvidence).toBeNull();
  });

  it('the shared wording names measured cells and leaves filled cells not covered', () => {
    const text = dtmCellsEvidenceText();
    expect(text).toMatch(/^E4 .* on measured cells/);
    expect(text).toMatch(/filled cells not covered/);
  });
});

describe('surfaces that show DTM evidence name measured cells', () => {
  it('the DEM package evidence contract', async () => {
    const { renderEvidenceContract } = await import('../src/terrain/export/demPackage');
    const { buildEvidenceContractView } = await import('../src/validation/evidenceBoundaryInspector');
    const text = renderEvidenceContract(buildEvidenceContractView('DTM')).join('\n');
    expect(text).toMatch(/Effective\s+.*measured cells/);
    expect(text).not.toMatch(/Effective\s+E4_CROSS_IMPLEMENTATION_VALIDATED\s*$/m);
  });

  it('the export evidence gate note', async () => {
    const { EVIDENCE_GATE_NOTE } = await import('../src/terrain/export/exportProvenance');
    expect(EVIDENCE_GATE_NOTE).toMatch(/measured cells/);
  });

  it('the terrain report DTM row', async () => {
    const { DTM_NOT_COVERED } = await import('../src/terrain/export/terrainReportContent');
    expect(DTM_NOT_COVERED).toMatch(/measured cells/);
    expect(DTM_NOT_COVERED).toMatch(/filled cells not covered/);
  });
});
