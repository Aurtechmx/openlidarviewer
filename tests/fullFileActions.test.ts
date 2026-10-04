import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessFullFile, bindFullFile, fullFileAvailability, fullFileLabel, layerFacts, pointBasisLine,
  reviewSampleTip, useFullFile, formatGb, type FullFileLayerFacts,
} from '../src/app/fullFileActions';
import { estimateMemoryBytes, memoryCeilingBytes } from '../src/io/loadPlan';
import { compactPointCount } from '../src/terrain/datasetIntelligence';
import { FULL_RES_CLASS_EDITS_REFUSAL } from '../src/export/fullResClassGuard';
import { buildExportSummary } from '../src/export/exportSummary';

/** Three synthetic files: a small complete load, a strided one, and a heavy one. */
function synth(kind: 'small' | 'strided' | 'heavy', over: Partial<FullFileLayerFacts> = {}): FullFileLayerFacts {
  const shapes = {
    small: { resident: 120_000, declared: 120_000, reduced: false, fileBytes: 120_000 * 34 },
    strided: { resident: 1_850_000, declared: 9_430_000, reduced: true, fileBytes: 9_430_000 * 34 },
    heavy: { resident: 2_400_000, declared: 410_000_000, reduced: true, fileBytes: 410_000_000 * 34 },
  }[kind];
  return {
    id: `layer-${kind}`, hasSource: true, truncated: false, format: 'las',
    attributes: { hasColor: true, hasIntensity: true, hasClassification: true, hasNormals: false, hasLasExtras: true },
    hasClassEdits: false, includeClassification: true, ...shapes, ...over,
  };
}

const desktop16 = { deviceMemoryGB: 16, isMobile: false };

describe('assessFullFile', () => {
  it('hides the action for a complete load, a truncated file and a layer without its source', () => {
    expect(assessFullFile(synth('small'), desktop16).show).toBe(false);
    expect(assessFullFile(synth('strided', { truncated: true }), desktop16).show).toBe(false);
    expect(assessFullFile(synth('strided', { hasSource: false }), desktop16).show).toBe(false);
    expect(assessFullFile(synth('strided', { declared: null }), desktop16).show).toBe(false);
    expect(assessFullFile(null, desktop16).show).toBe(false);
  });

  it('labels and estimates from the layer itself', () => {
    const f = synth('strided');
    const a = assessFullFile(f, desktop16);
    expect(a.show).toBe(true);
    expect(a.allowed).toBe(true);
    expect(a.label).toBe(`Export all ${compactPointCount(f.declared!)} points`);
    expect(a.label).toBe(fullFileLabel(f.declared!));
    expect(a.hint).toBe(`Exports every point in the file. Analyses still use the ${compactPointCount(f.resident)} display sample.`);
    expect(a.estimateBytes).toBe(estimateMemoryBytes({ pointCount: f.declared!, attributes: f.attributes, fileBytes: f.fileBytes, format: 'las' }));
    expect(a.ceilingBytes).toBe(memoryCeilingBytes(16, false));
  });

  it('a lighter attribute set lowers the estimate', () => {
    const rich = assessFullFile(synth('strided'), desktop16).estimateBytes;
    const bare = assessFullFile(synth('strided', { attributes: { hasColor: false, hasIntensity: false, hasClassification: false, hasNormals: false } }), desktop16).estimateBytes;
    expect(bare).toBeLessThan(rich);
  });

  it('refuses a heavy file with both figures', () => {
    const f = synth('heavy');
    const a = assessFullFile(f, desktop16);
    expect(a.show).toBe(true);
    expect(a.allowed).toBe(false);
    expect(a.reason).toBe(`Exporting every point needs about ${formatGb(a.estimateBytes)}; this device allows about ${formatGb(memoryCeilingBytes(16, false))}.`);
  });

  it('says the ceiling is estimated when the browser reports no memory', () => {
    const a = assessFullFile(synth('heavy'), { deviceMemoryGB: undefined, isMobile: false });
    expect(a.memoryEstimated).toBe(true);
    expect(a.reason).toContain(`about ${formatGb(memoryCeilingBytes(undefined, false))} (estimated)`);
  });

  it.each([
    ['low desktop', { deviceMemoryGB: 2, isMobile: false }],
    ['medium desktop', { deviceMemoryGB: 4, isMobile: false }],
    ['high desktop', { deviceMemoryGB: 32, isMobile: false }],
    ['mobile 4 GB', { deviceMemoryGB: 4, isMobile: true }],
    ['unknown memory', { deviceMemoryGB: undefined, isMobile: false }],
  ])('agrees with the loadPlan ceiling on %s', (_name, device) => {
    const a = assessFullFile(synth('strided'), device);
    const ceiling = memoryCeilingBytes(device.deviceMemoryGB, device.isMobile);
    expect(a.ceilingBytes).toBe(ceiling);
    expect(a.allowed).toBe(a.estimateBytes <= ceiling);
    if (!a.allowed) expect(a.reason).toContain(formatGb(ceiling));
  });

  it('mobile with 4 GB refuses the strided file the 16 GB desktop allows', () => {
    expect(assessFullFile(synth('strided'), desktop16).allowed).toBe(true);
    const phone = assessFullFile(synth('strided'), { deviceMemoryGB: 4, isMobile: true });
    expect(phone.allowed).toBe(phone.estimateBytes <= memoryCeilingBytes(4, true));
  });

  it('refuses class edits that a re-decode would drop, and allows them when classification is left out', () => {
    expect(assessFullFile(synth('strided', { hasClassEdits: true }), desktop16).reason).toBe(FULL_RES_CLASS_EDITS_REFUSAL);
    expect(assessFullFile(synth('strided', { hasClassEdits: true, includeClassification: false }), desktop16).allowed).toBe(true);
  });
});

describe('point basis', () => {
  it.each([
    ['small', 120_000, 120_000],
    ['strided', 1_850_000, 9_430_000],
    ['heavy', 2_400_000, 410_000_000],
  ])('states the %s file basis from its counts', (_k, held, declared) => {
    const c = (n: number) => n.toLocaleString('en-US');
    expect(pointBasisLine(true, declared, null)).toBe(`Point basis: full file (${c(declared)} points)`);
    expect(pointBasisLine(false, held, declared)).toBe(
      held < declared ? `Point basis: display sample (${c(held)} of ${c(declared)} points)` : `Point basis: display sample (${c(held)} points)`,
    );
  });

  it('the export summary writes the source count and the full-file basis when full resolution is on', () => {
    const f = synth('strided');
    const on = buildExportSummary({ pointCount: f.resident, sourcePointCount: f.declared, format: 'las14', crsMode: 'keep', viewDecimated: true, fullRes: true });
    expect(on.pointCountLabel).toBe(`${f.declared!.toLocaleString()} points`);
    expect(on.basisLabel).toBe(pointBasisLine(true, f.declared!, null));
    const off = buildExportSummary({ pointCount: f.resident, sourcePointCount: f.declared, format: 'las14', crsMode: 'keep', viewDecimated: true, fullRes: false });
    expect(off.basisLabel).toBe(pointBasisLine(false, f.resident, f.declared));
  });
});

describe('useFullFile through the bound host', () => {
  afterEach(() => bindFullFile(null));

  function bind(layers: FullFileLayerFacts[], active: string) {
    const openExport = vi.fn();
    bindFullFile({ facts: (id) => layers.find((l) => l.id === id) ?? null, activeId: () => active, openExport });
    return openExport;
  }

  it('opens Export on the targeted layer, not just the active one', () => {
    const a = synth('strided', { id: 'a' });
    const b = synth('strided', { id: 'b', resident: 900_000, declared: 5_200_000 });
    const open = bind([a, b], 'a');
    const r = useFullFile('export', 'b', desktop16);
    expect(r.label).toBe(fullFileLabel(5_200_000));
    expect(open).toHaveBeenCalledWith('b', undefined);
    expect(fullFileAvailability(undefined, desktop16).label).toBe(fullFileLabel(a.declared!));
  });

  it('passes the class-edit refusal before any decode', () => {
    const open = bind([synth('strided', { id: 'x', hasClassEdits: true })], 'x');
    useFullFile('export', undefined, desktop16);
    expect(open).toHaveBeenCalledWith('x', FULL_RES_CLASS_EDITS_REFUSAL);
  });

  it('does nothing for a complete load', () => {
    const open = bind([synth('small', { id: 's' })], 's');
    expect(useFullFile('export', undefined, desktop16).show).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(reviewSampleTip()).toBe('');
  });

  it('names the sample and the remedy in the review tip', () => {
    const f = synth('strided', { id: 't' });
    bind([f], 't');
    const tip = reviewSampleTip();
    expect(tip).toContain(compactPointCount(f.resident));
    expect(tip).toContain(fullFileLabel(f.declared!));
  });
});

describe('layerFacts', () => {
  it('reads counts, format and attributes from the cloud', () => {
    const f = layerFacts({
      id: 'c',
      cloud: { pointCount: 1000, sourceDeclaredPointCount: 8000, sourceFormat: 'laz', colors: new Uint8Array(3), gpsTime: new Float64Array(1) },
      file: { size: 4096 }, reduced: true, hasClassEdits: false, includeClassification: true,
    });
    expect(f).toMatchObject({ resident: 1000, declared: 8000, format: 'laz', fileBytes: 4096, hasSource: true, truncated: false });
    expect(f.attributes).toMatchObject({ hasColor: true, hasIntensity: false, hasLasExtras: true });
    const t = layerFacts({ id: 'd', cloud: { pointCount: 10, sourceFormat: 'las', metadata: { truncation: { read: 10, declared: 20 } } }, file: null, reduced: false, hasClassEdits: false, includeClassification: true });
    expect(t.truncated).toBe(true);
    expect(t.hasSource).toBe(false);
  });
});
