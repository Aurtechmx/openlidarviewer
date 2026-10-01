/**
 * clearedProvenanceSurfaces.test.ts
 *
 * The 'cleared' classification provenance reaches every surface that states
 * where the classes came from: the export summary and its warning, the Export
 * panel facts, the XYZ comment, the report (Scan QA and dataset summary), the
 * Export Health row and the Process Studio capability model. Derived codes
 * carry the classifier's registry id@version into the XYZ comment and report.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { ClassEditHistory, recordClassEdit } from '../src/render/measure/classEditHistory';
import { buildExportSummary } from '../src/export/exportSummary';
import { CLEARED_CLASS_NOTE } from '../src/export/clearedClassNote';
import { exportClassFacts } from '../src/ui/ExportPanel';
import { exportCloud } from '../src/io/exporters';
import { buildScanQuality } from '../src/report/ReportScanQuality';
import { buildDatasetSummary, type MetadataInputs } from '../src/report/ReportMetadataSection';
import { buildExportHealth } from '../src/intelligence/scanStory';
import { signalsFromLive, type LiveScanAccessors } from '../src/app/processStudioMount';
import { deriveScanFacts } from '../src/process/scanFacts';

function classified(): PointCloud {
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    origin: [0, 0, 0],
    sourceFormat: 'xyz',
    name: 'tile.xyz',
    classification: Uint8Array.from([2, 6, 5]),
  });
}

function cleared(): PointCloud {
  const pc = classified();
  recordClassEdit(new ClassEditHistory(), pc, (b) => b.fill(1), 'cleared');
  return pc;
}

describe('export summary', () => {
  it('labels a cleared classification and warns before it is written', () => {
    const s = buildExportSummary({ pointCount: 3, format: 'las14', crsMode: 'keep', classification: 'cleared' });
    expect(s.classificationLabel).toBe(`Classification included (${CLEARED_CLASS_NOTE})`);
    expect(s.warnings.map((w) => w.message).join(' ')).toMatch(CLEARED_CLASS_NOTE);
  });

  it('leaves the source and derived wording unchanged', () => {
    const base = { pointCount: 3, format: 'las14' as const, crsMode: 'keep' as const };
    expect(buildExportSummary({ ...base, classification: 'source' }).classificationLabel).toBe('Classification included (source)');
    expect(buildExportSummary({ ...base, classification: 'derived' }).classificationLabel).toBe('Classification included (derived)');
  });
});

describe('Export panel facts', () => {
  it('reports source, cleared and none from the cloud', () => {
    expect(exportClassFacts(classified()).classProvenance).toBe('source');
    expect(exportClassFacts(cleared()).classProvenance).toBe('cleared');
    const none = new PointCloud({ positions: new Float32Array(3), origin: [0, 0, 0], sourceFormat: 'xyz', name: 'n' });
    expect(exportClassFacts(none).classProvenance).toBe('none');
  });
});

describe('XYZ comment', () => {
  it('stamps CLEARED with the shared wording', () => {
    expect(exportCloud(cleared(), 'xyz')).toMatch(`# classification: CLEARED (${CLEARED_CLASS_NOTE})`);
    expect(exportCloud(classified(), 'xyz')).not.toMatch(/CLEARED|DERIVED/);
  });

  it('stamps DERIVED with the registry method id@version', () => {
    const pc = cleared();
    recordClassEdit(new ClassEditHistory(), pc, (b) => b.set([2, 2, 2]), 'derived', 'olv.class.derived-heuristic@3');
    expect(exportCloud(pc, 'xyz')).toMatch(/# classification: DERIVED \(heuristic ground\/vegetation\/building, olv\.class\.derived-heuristic@3/);
  });
});

describe('report', () => {
  const qa = {
    coordinateHeadline: 'h', positionLabel: 'p', heightLabel: 'z', positionKnown: true, heightKnown: true,
    hasClassification: true, classificationDerived: false, attributes: [],
  };
  it('Scan QA states the cleared classes', () => {
    expect(buildScanQuality({ ...qa, classificationCleared: true }).classificationNote)
      .toBe(`Classification: ${CLEARED_CLASS_NOTE}.`);
    expect(buildScanQuality(qa).classificationNote).toMatch(/supplied by the producer/);
  });

  const meta: MetadataInputs = {
    fileName: 'tile.las', format: 'LAS', sourcePointCount: 3, width: 1, depth: 1, height: 1, density: 1,
    hasRgb: false, hasIntensity: false, hasClassification: true,
  };
  const row = (m: MetadataInputs) => buildDatasetSummary(m).find((r) => r.label === 'Classification')?.value;
  it('dataset summary states cleared, and derived with its method', () => {
    expect(row({ ...meta, classificationCleared: true })).toMatch(CLEARED_CLASS_NOTE);
    expect(row({ ...meta, classificationDerived: true, classificationMethod: 'olv.class.derived-heuristic@3' }))
      .toMatch('derived by the viewer (heuristic, olv.class.derived-heuristic@3)');
  });
});

describe('Export Health', () => {
  it('rates a cleared classification as caution', () => {
    const r = buildExportHealth({ classification: 'cleared' }).rows.find((x) => x.label === 'Classification');
    expect(r).toEqual({ label: 'Classification', value: 'Cleared in viewer', tier: 'caution' });
  });
});

describe('Process Studio capability model', () => {
  const live: LiveScanAccessors = {
    hasStreamingSource: () => false,
    getStreamingPointCount: () => null,
    getActivePointCount: () => 3,
    getResolvedCrs: () => null,
    getPresentClassCodes: () => [1],
    getClassificationDerived: () => false,
  };
  it('carries cleared provenance, which never backs trusted ground', () => {
    const s = signalsFromLive({ ...live, getPresentClassCodes: () => [1, 2], getClassificationCleared: () => true })!;
    expect(s.classificationProvenance).toBe('cleared');
    expect(deriveScanFacts(s).groundClassified).toBe(false);
  });
  it('a source classification is still the producer', () => {
    expect(signalsFromLive(live)!.classificationProvenance).toBe('producer');
  });
});

describe('a hand edit on the cleared layer', () => {
  // Clear, then a lasso sets one point to Building: the codes now hold class 6,
  // so no surface may still say that every point is class 1.
  const ALL_ONE = /all points class 1|all class 1|every point (is )?class 1/i;

  function clearedThenEdited(): PointCloud {
    const pc = classified();
    const history = new ClassEditHistory();
    recordClassEdit(history, pc, (b) => b.fill(1), 'cleared');
    recordClassEdit(history, pc, (b) => { b[0] = 6; });
    return pc;
  }

  it('the XYZ header keeps CLEARED without claiming every point is class 1', () => {
    const pc = clearedThenEdited();
    expect([...pc.classification!]).toEqual([6, 1, 1]);
    expect(pc.classificationProvenance).toBe('cleared');
    const header = exportCloud(pc, 'xyz').split('\n').filter((l) => l.startsWith('#')).join('\n');
    expect(header).toMatch(/# classification: CLEARED/);
    expect(header).not.toMatch(ALL_ONE);
    expect(header).toMatch(/by hand/);
  });

  it('the report, the export summary and Export Health say the same', () => {
    const qa = buildScanQuality({
      coordinateHeadline: 'h', positionLabel: 'p', heightLabel: 'z', positionKnown: true, heightKnown: true,
      hasClassification: true, classificationDerived: false, classificationCleared: true, attributes: [],
    }).classificationNote;
    const meta = buildDatasetSummary({
      fileName: 'tile.las', format: 'LAS', sourcePointCount: 3, width: 1, depth: 1, height: 1, density: 1,
      hasRgb: false, hasIntensity: false, hasClassification: true, classificationCleared: true,
    }).find((r) => r.label === 'Classification')?.value ?? '';
    const s = buildExportSummary({ pointCount: 3, format: 'las14', crsMode: 'keep', classification: 'cleared' });
    const health = buildExportHealth({ classification: 'cleared' }).rows.find((x) => x.label === 'Classification')?.value ?? '';
    for (const text of [qa, meta, s.classificationLabel, ...s.warnings.map((w) => w.message), health]) {
      expect(text).not.toMatch(ALL_ONE);
    }
    expect(qa).toMatch(/by hand/);
    expect(meta).toMatch(/by hand/);
  });
});
