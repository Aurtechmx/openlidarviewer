import { beforeAll, expect, it } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { analysedBasisOf } from '../src/terrain/export/analysedBasis';
import { buildExportProvenance, provenanceJson } from '../src/terrain/export/exportProvenance';
import { buildTerrainReportContent } from '../src/terrain/export/terrainReportContent';
import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';
import { readyResult } from './support/readyContourResult';

beforeAll(() => installAnalysePanelDom({ ns: true, noRaf: true }));

it('names a separate analysis sample on a fully loaded source in the files and workflow notes', () => {
  const basis = analysedBasisOf({coverage: 'full', pointCount: 600_000}, 300_000, 600_000);
  const options = {analysedBasis: basis, verticalUnitToMetres: 1};
  const result = readyResult();
  const provenance = buildExportProvenance(result, options);
  const record = provenanceJson(provenance);
  expect(record.exportReadiness).toBe('Preview');
  expect(record.analysedBasisLine).toContain('analysis subsample');
  expect(provenance.sourceInterpretation.dataBasis).toBe('sampled');
  expect(basis.coverage).toBe('full');
  const report = buildTerrainReportContent(result, options);
  const dem = report.workflows.find(row => row.label === 'DEM export');
  expect(dem?.note).toContain('sample');
});

it('keeps the full basis for accounted Withheld exclusions', () => {
  const basis = analysedBasisOf({coverage: 'full', pointCount: 100}, 90, 100, null, 100, 10);
  const record = buildExportProvenance(readyResult(), {analysedBasis: basis, verticalUnitToMetres: 1});
  expect(record.sourceInterpretation.dataBasis).toBe('full');
  expect(record.analysedBasisLine).toContain('(full read)');
});

it('the DEM rail and export agree on a sampled grid that passes the raw quality gate', async () => {
  const {AnalysePanel} = await import('../src/ui/AnalysePanel');
  const pts = Array.from({length: 101 * 101}, (_, i) => {
    const x = i % 101;
    const y = Math.floor(i / 101);
    return {x, y, z: 2 + 0.16*x + 0.05*y + 0.2*Math.sin(y/9)*Math.cos(x/9), classification: 2};
  });
  const result = analyseContours(pts, {cellSizeM: 2, crs: 'EPSG:32610', verticalDatum: 'EPSG:5703', sampled: true});
  expect(result.quality.exportReadiness).toBe('available');
  const panel = new AnalysePanel({});
  panel.update(result);
  const note = (panel.element as unknown as FakeEl).findContaining('Preliminary DEM')[0].ownText;
  expect(note).toContain('export readiness: preview');
  expect(buildExportProvenance(result, {verticalUnitToMetres: 1}).exportReadiness).toBe('Preview');
});
