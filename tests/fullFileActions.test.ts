import { readFileSync } from 'node:fs';
import { exportLayerHooks } from '../src/ui/ExportPanel';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessFullFile, bindFullFile, fullFileAvailability, fullFileLabel, layerFacts, pointBasisLine,
  reviewSampleTip, useFullFile, formatGb, assessReload, useReload, takeReloadBudget, type FullFileLayerFacts,
  e57DecodeBytesFromAttributes, fullDecodeRefusal, fullFileCeilingBytes, fullFileEstimateBytes,
} from '../src/app/fullFileActions';
import { E57_DECODE_CEILING_BYTES, estimateMemoryBytes, memoryCeilingBytes, planE57Decode, planLoad } from '../src/io/loadPlan';
import { GPU_HARD_POINT_CEILING } from '../src/render/deviceProfile';
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
    const r = useFullFile('b', desktop16);
    expect(r.label).toBe(fullFileLabel(5_200_000));
    expect(open).toHaveBeenCalledWith('b', undefined);
    expect(fullFileAvailability(undefined, desktop16).label).toBe(fullFileLabel(a.declared!));
  });

  it('passes the class-edit refusal before any decode', () => {
    const open = bind([synth('strided', { id: 'x', hasClassEdits: true })], 'x');
    useFullFile(undefined, desktop16);
    expect(open).toHaveBeenCalledWith('x', FULL_RES_CLASS_EDITS_REFUSAL);
  });

  it('does nothing for a complete load', () => {
    const open = bind([synth('small', { id: 's' })], 's');
    expect(useFullFile(undefined, desktop16).show).toBe(false);
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

describe('reload at higher density', () => {
  afterEach(() => bindFullFile(null));
  const high = { deviceMemoryGB: 16, isMobile: false, tier: 'high' as const };

  it('targets min(GPU ceiling, memory fit, declared count) from planLoad', () => {
    const f = synth('strided');
    const p = assessReload(f, high);
    const plan = planLoad({ sourceCount: f.declared!, budget: Math.min(GPU_HARD_POINT_CEILING, f.declared!), fileBytes: f.fileBytes, format: f.format, attributes: f.attributes, isMobile: false, deviceMemoryGB: 16 });
    expect(p.target).toBe(Math.min(plan.targetCount, GPU_HARD_POINT_CEILING, f.declared!));
    expect(p.target).toBeLessThanOrEqual(GPU_HARD_POINT_CEILING);
    expect(p.allowed).toBe(true);
    expect(p.allPoints).toBe(false);
    expect(p.confirm).toBe(`Shows ${compactPointCount(p.target)} of ${compactPointCount(f.declared!)} points (still a sample). Needs about ${formatGb(p.estimateBytes)} (estimated). May run slower.`);
    expect(p.label).toBe(`Reload at ${compactPointCount(p.target)} points`);
  });

  it('calls it all points only when the declared count would be resident', () => {
    const f = synth('strided', { resident: 1_000_000, declared: 3_500_000, fileBytes: 3_500_000 * 34 });
    const p = assessReload(f, high);
    expect(p.target).toBe(3_500_000);
    expect(p.allPoints).toBe(true);
    expect(p.label).toBe(`Reload all ${compactPointCount(3_500_000)} points`);
    expect(p.confirm).toMatch(/^Shows all /);
    expect(assessReload(synth('strided'), high).label).not.toContain('all');
  });

  it('refuses on a low tier, on mobile, and when it would not add points', () => {
    expect(assessReload(synth('strided'), { ...high, tier: 'low' }).allowed).toBe(false);
    expect(assessReload(synth('strided'), { deviceMemoryGB: 4, isMobile: true, tier: 'medium' }).allowed).toBe(false);
    const full = synth('strided', { resident: GPU_HARD_POINT_CEILING, declared: 20_000_000, fileBytes: 20_000_000 * 34 });
    expect(assessReload(full, high).reason).toBe(`${compactPointCount(GPU_HARD_POINT_CEILING)} of ${compactPointCount(20_000_000)} points are loaded. A reload would not add points on this device.`);
  });

  it('refuses the heavy file that does not fit memory, and hides for a complete load', () => {
    const heavy = assessReload(synth('heavy'), high);
    expect(heavy.allowed).toBe(false);
    expect(heavy.reason).toContain(formatGb(heavy.estimateBytes));
    expect(heavy.reason).toContain(`over the ${formatGb(memoryCeilingBytes(16, false))} this device allows for a loaded layer`);
    expect(heavy.reason).toContain('opens as a streamed scan');
    expect(heavy.reason).toMatch(/ of .* points are loaded\./);
    expect(assessReload(synth('small'), high).show).toBe(false);
  });

  it('says a LAS too large to hold would stream, and a non-streaming format does not fit', () => {
    const las = synth('heavy');
    const plan = planLoad({ sourceCount: las.declared!, budget: GPU_HARD_POINT_CEILING, fileBytes: las.fileBytes, format: 'las', attributes: las.attributes, isMobile: false, deviceMemoryGB: 16 });
    expect(plan.buildThenStream).toBe(true);
    expect(assessReload(las, high).reason).toMatch(/opens as a streamed scan, and a reload only replaces a loaded layer\.$/);
    const ply = assessReload(synth('heavy', { format: 'ply' }), high);
    expect(ply.allowed).toBe(false);
    expect(ply.reason).toContain(`more than the ${formatGb(memoryCeilingBytes(16, false))} this device allows`);
    expect(ply.reason).not.toContain('streamed');
  });

  it('refuses while the layer\'s classes differ from the file, naming the cause', () => {
    const lead = (f: FullFileLayerFacts) => `${compactPointCount(f.resident)} of ${compactPointCount(f.declared!)} points are loaded. A reload reads the original file, so it is unavailable while this layer's classes differ from the file: `;
    const edited = synth('strided', { hasClassEdits: true, classCauses: { edited: true, derived: false } });
    expect(assessReload(edited, high).allowed).toBe(false);
    expect(assessReload(edited, high).reason).toBe(`${lead(edited)}it has manual class edits. Exporting with classification keeps them; a saved session does not.`);
    const derived = synth('strided', { hasClassEdits: true, classCauses: { edited: false, derived: true } });
    expect(assessReload(derived, high).allowed).toBe(false);
    expect(assessReload(derived, high).reason).toBe(`${lead(derived)}its classes were derived or cleared in the app, not read from the file. Exporting with classification keeps them; a saved session does not.`);
    const both = synth('strided', { hasClassEdits: true, classCauses: { edited: true, derived: true } });
    expect(assessReload(both, high).reason).toBe(`${lead(both)}its classes were derived or cleared in the app, not read from the file. Exporting with classification keeps them; a saved session does not.`);
    expect(assessReload(both, high).reason).not.toMatch(/save the session first|unsaved/i);
  });

  it('names the findings and compare difference a reload clears', () => {
    expect(assessReload(synth('strided'), high).confirm).not.toContain('Reloading clears');
    expect(assessReload(synth('strided', { findings: 1 }), high).confirm).toMatch(/ Reloading clears its 1 saved finding\.$/);
    expect(assessReload(synth('strided', { findings: 3, inCompare: true }), high).confirm)
      .toMatch(/ Reloading clears its 3 saved findings and the compare difference computed on it\.$/);
  });

  it('confirms, then reopens the targeted layer with the budget the open path takes once', async () => {
    const f = synth('strided', { id: 'r' });
    let seen: number | null = null;
    const reload = vi.fn(async () => { seen = takeReloadBudget(); });
    bindFullFile({ facts: (id) => (id === 'r' ? f : null), activeId: () => 'r', openExport: vi.fn(), reload });
    const ask = vi.fn(async () => true);
    const p = await useReload('r', high, ask);
    expect(ask).toHaveBeenCalledWith(p.confirm, 'Reload');
    expect(reload).toHaveBeenCalledWith('r', p.target);
    expect(seen).toBe(p.target);
    expect(takeReloadBudget()).toBeNull();
  });

  it('does not reload when the confirm is declined, and notifies a refusal', async () => {
    const notify = vi.fn();
    const reload = vi.fn(async () => {});
    bindFullFile({ facts: () => synth('strided', { id: 'q' }), activeId: () => 'q', openExport: vi.fn(), reload, notify });
    await useReload('q', high, async () => false);
    expect(reload).not.toHaveBeenCalled();
    await useReload('q', { ...high, tier: 'low' }, async () => true);
    expect(reload).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('low performance tier'));
  });
});

describe('GPU point ceiling', () => {
  it('matches the upload guard in Viewer.ts', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/render/Viewer.ts', import.meta.url)), 'utf8');
    const m = src.match(/const GPU_HARD_POINT_CEILING = ([\d_]+);/);
    expect(Number(m![1].replace(/_/g, ''))).toBe(GPU_HARD_POINT_CEILING);
  });
});

describe('exportLayerHooks reload', () => {
  type Outcome = 'ok' | 'cancel' | 'fail' | 'busy' | 'two' | 'otherFile';
  function setup(outcome: Outcome) {
    const file = new File([new Uint8Array(4)], 'a.las');
    const clouds = ['old', 'other'];
    const sourceFiles = new Map<string, File>([['old', file]]);
    const removeLayer = vi.fn((id: string) => { clouds.splice(clouds.indexOf(id), 1); });
    const notify = vi.fn();
    const hooks = exportLayerHooks({
      scans: { activeId: 'other', setActive: () => {} },
      viewer: () => ({ getCloud: () => null, classificationEpoch: () => 0, clouds: () => clouds }),
      sourceFiles, reduced: new Map(),
      reopen: async (f) => {
        if (outcome === 'fail') throw new Error('decode failed');
        if (outcome === 'two') {
          clouds.push('new', 'new2');
          sourceFiles.set('new', f);
          sourceFiles.set('new2', f);
          return;
        }
        if (outcome === 'otherFile') {
          clouds.push('new');
          sourceFiles.set('new', new File([new Uint8Array(4)], 'a.las'));
          return;
        }
        if (outcome !== 'ok') return; // cancelled, or the "Already loading" guard: no layer added
        clouds.push('new');
        sourceFiles.set('new', f);
      },
      removeLayer, notify,
    });
    return { hooks, clouds, removeLayer, notify };
  }

  it('replaces a layer that is not active once the reopened layer is in', async () => {
    const t = setup('ok');
    await t.hooks.reloadLayer!('old', 5);
    expect(t.removeLayer).toHaveBeenCalledWith('old');
    expect(t.clouds).toEqual(['other', 'new']);
    expect(t.notify).not.toHaveBeenCalled();
  });

  for (const outcome of ['cancel', 'fail', 'busy', 'two', 'otherFile'] as const) {
    it(`keeps the old layer when the reopen ends with ${outcome}`, async () => {
      const t = setup(outcome);
      await t.hooks.reloadLayer!('old', 5);
      expect(t.removeLayer).not.toHaveBeenCalled();
      expect(t.clouds.slice(0, 2)).toEqual(['old', 'other']);
      expect(t.notify).toHaveBeenCalledWith('The reload did not complete. The layer is unchanged.');
    });
  }
});

describe('exportLayerHooks class causes', () => {
  const hooksFor = (provenance: string, epoch: number) => exportLayerHooks({
    scans: { activeId: 'a', setActive: () => {} },
    viewer: () => ({
      getCloud: () => ({ classificationProvenance: provenance, pointCount: 1 }) as never,
      classificationEpoch: () => epoch,
      clouds: () => ['a'],
    }),
    sourceFiles: new Map(), reduced: new Map(),
    reopen: async () => {}, removeLayer: () => {}, notify: () => {},
  });

  it('counts an epoch as a hand edit only on source classes', () => {
    expect(hooksFor('source', 2).layerSource!('a')!.classCauses).toEqual({ edited: true, derived: false });
    expect(hooksFor('derived', 3).layerSource!('a')!.classCauses).toEqual({ edited: false, derived: true });
    expect(hooksFor('cleared', 1).layerSource!('a')!.classCauses).toEqual({ edited: false, derived: true });
    expect(hooksFor('source', 0).layerSource!('a')!.classCauses).toEqual({ edited: false, derived: false });
  });
});


describe('E57 fit check for Export all N points', () => {
  // openpitmine.e57: 26.9 M records, xyz + RGB, the file loadPlan.ts cites.
  const OPEN_PIT = {
    sourceCount: 26_910_771, fileBytes: 616_108_032, decodeBytesPerRecord: 6 * 8,
    attributes: { hasColor: true, hasIntensity: false, hasClassification: false, hasNormals: false },
  };
  const facts = (over: Partial<FullFileLayerFacts> = {}): FullFileLayerFacts => ({
    id: 'pit', hasSource: true, reduced: true, truncated: false, resident: 4_000_000,
    declared: OPEN_PIT.sourceCount, fileBytes: OPEN_PIT.fileBytes, format: 'e57', attributes: OPEN_PIT.attributes,
    hasClassEdits: false, includeClassification: false, ...over,
  });

  it('uses the decode planner estimate recorded at load', () => {
    const plan = planE57Decode({ ...OPEN_PIT, isMobile: false, deviceMemoryGB: 16 });
    const a = assessFullFile(facts({ e57FullDecodeEstimateBytes: plan.fullDecodeEstimateBytes }), desktop16);
    expect(a.estimateBytes).toBe(plan.fullDecodeEstimateBytes);
    expect(a.ceilingBytes).toBe(plan.ceilingBytes);
  });

  it('without a recorded estimate, matches the planner for the same columns', () => {
    const plan = planE57Decode({ ...OPEN_PIT, isMobile: false, deviceMemoryGB: 16 });
    expect(e57DecodeBytesFromAttributes(OPEN_PIT.attributes)).toBe(OPEN_PIT.decodeBytesPerRecord);
    expect(fullFileEstimateBytes(facts(), OPEN_PIT.sourceCount)).toBe(plan.fullDecodeEstimateBytes);
    const generic = estimateMemoryBytes({
      pointCount: OPEN_PIT.sourceCount, attributes: OPEN_PIT.attributes, fileBytes: OPEN_PIT.fileBytes, format: 'e57',
    });
    expect(generic).toBeLessThan(plan.fullDecodeEstimateBytes);
  });

  it('holds E57 to the whole-file decode cap and refuses over it with the figures', () => {
    expect(fullFileCeilingBytes('e57', desktop16)).toBe(E57_DECODE_CEILING_BYTES);
    expect(fullFileCeilingBytes('las', desktop16)).toBe(memoryCeilingBytes(16, false));
    const a = assessFullFile(facts(), desktop16);
    expect(a.show).toBe(true);
    expect(a.allowed).toBe(false);
    expect(a.estimateBytes).toBeGreaterThan(E57_DECODE_CEILING_BYTES);
    expect(a.reason).toBe(`Exporting every point needs about ${formatGb(a.estimateBytes)}; this device allows about ${formatGb(E57_DECODE_CEILING_BYTES)}.`);
  });

  it('allows an E57 whose planner estimate fits under the cap', () => {
    const a = assessFullFile(facts({ declared: 5_000_000, fileBytes: 120_000_000, resident: 1_000_000 }), desktop16);
    expect(a.estimateBytes).toBeLessThanOrEqual(E57_DECODE_CEILING_BYTES);
    expect(a.allowed).toBe(true);
  });

  it('layerFacts carries the recorded estimate from the cloud metadata', () => {
    const f = layerFacts({
      id: 'pit',
      cloud: { pointCount: 10, declaredPointCount: 100, sourceFormat: 'e57', metadata: { e57FullDecodeEstimateBytes: 123 } },
      file: { size: 1 }, reduced: true, hasClassEdits: false, includeClassification: false,
    });
    expect(f.e57FullDecodeEstimateBytes).toBe(123);
  });

  it('a strided re-decode is refused, never written as the full file', () => {
    expect(fullDecodeRefusal({ pointCount: 13_455_386, loadStride: 2, declaredPointCount: 26_910_771 })).toBe(
      `The full-resolution re-decode read ${compactPointCount(13_455_386)} of ${compactPointCount(26_910_771)} points (one record in 2) to fit memory, so nothing was exported.`,
    );
    expect(fullDecodeRefusal({ pointCount: 26_910_771, loadStride: 1, declaredPointCount: 26_910_771 })).toBeNull();
    expect(fullDecodeRefusal({ pointCount: 900 })).toBeNull();
    expect(fullDecodeRefusal({ pointCount: 60, declaredPointCount: 100, metadata: { truncation: { read: 60, declared: 100 } } })).toBe(
      'The source file ends after 60 of its 100 declared points, so nothing was exported as the full file.',
    );
    expect(fullDecodeRefusal({ pointCount: 80, declaredPointCount: 100, loadStride: 1 })).toBe(
      'The full-resolution re-decode read 80 of 100 declared points, so nothing was exported as the full file.',
    );
  });
});
