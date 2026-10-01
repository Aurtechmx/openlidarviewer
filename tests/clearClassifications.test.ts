/**
 * clearClassifications.test.ts
 *
 * Clear classifications, Restore earlier classes, and Auto-classify after a
 * clear, driven through the same recorded edit the Viewer uses
 * (`recordClassEdit` / `stepClassEdit` over a real `PointCloud` and a real
 * `ClassEditHistory`). The Viewer method is a three-line wrapper over these
 * and needs a GPU to construct; the e2e spec covers that wrapper in a browser.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PointCloud } from '../src/model/PointCloud';
import {
  ClassEditHistory,
  recordClassEdit,
  stepClassEdit,
} from '../src/render/measure/classEditHistory';
import {
  canRestoreOriginal,
  clearClassification,
  restoreOriginalClassification,
  type ClassLayerHost,
} from '../src/render/class/classLayer';
import { producerClassifiesGround, analysisClassification } from '../src/render/integrableClouds';
import { encodeExtendedClassificationFlags } from '../src/lasSemantics';
import { withheldCount } from '../src/science/withheldPolicy';
import type { ClassState } from '../src/model/PointCloud';

const SOURCE = [2, 2, 3, 5, 6, 6, 9, 2, 1, 0];

function cloud(codes: readonly number[] | null = SOURCE, flags?: Uint8Array): PointCloud {
  const n = codes?.length ?? SOURCE.length;
  return new PointCloud({
    positions: new Float32Array(n * 3).map((_, i) => i),
    origin: [0, 0, 0],
    sourceFormat: 'las',
    name: 'tile.las',
    ...(codes ? { classification: Uint8Array.from(codes) } : {}),
    ...(flags ? { classificationFlags: flags } : {}),
  });
}

/** A host with the Viewer's recorded-edit semantics, minus the GPU. */
function host(pc: PointCloud) {
  const history = new ClassEditHistory();
  const h: ClassLayerHost & {
    undo(): boolean;
    redo(): boolean;
    derive(codes: Uint8Array, method?: string): void;
    readonly history: ClassEditHistory;
  } = {
    getCloud: (id) => (id === 'a' ? pc : undefined),
    editClassification: (_id, edit, to?: ClassState) => { recordClassEdit(history, pc, edit, to); },
    undo: () => stepClassEdit(history, pc, 'undo') !== null,
    redo: () => stepClassEdit(history, pc, 'redo') !== null,
    // Viewer.applyDerivedClassification on a cloud that already has codes.
    derive: (codes, method) => { recordClassEdit(history, pc, (buf) => buf.set(codes), 'derived', method); },
    history,
  };
  return h;
}

describe('Clear classifications', () => {
  it('sets every point to class 1 and marks the layer cleared', () => {
    const pc = cloud();
    expect(pc.classificationProvenance).toBe('source');
    expect(clearClassification(host(pc), 'a')).toBe('ok');
    expect([...pc.classification!]).toEqual(SOURCE.map(() => 1));
    expect(pc.classificationProvenance).toBe('cleared');
    expect(pc.classificationIsDerived).toBe(false);
  });

  it('Undo restores the producer codes exactly, and Redo clears again', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    expect(h.undo()).toBe(true);
    expect([...pc.classification!]).toEqual(SOURCE);
    expect(pc.classificationProvenance).toBe('source');
    expect(h.redo()).toBe(true);
    expect([...pc.classification!]).toEqual(SOURCE.map(() => 1));
    expect(pc.classificationProvenance).toBe('cleared');
  });

  it('keeps one copy of the original codes, taken before the first clear', () => {
    const pc = cloud();
    const live = pc.classification;
    clearClassification(host(pc), 'a');
    // The live buffer is edited in place; the copy is a separate allocation.
    expect(pc.classification).toBe(live);
    expect(pc.originalClassification).not.toBe(live);
    expect([...pc.originalClassification!]).toEqual(SOURCE);
    expect(pc.originalClassification!.byteLength).toBe(SOURCE.length); // one byte per point
  });

  it('is undoable even when every point was already class 1', () => {
    const pc = cloud([1, 1, 1]);
    const h = host(pc);
    clearClassification(h, 'a');
    expect(pc.classificationProvenance).toBe('cleared');
    expect(h.undo()).toBe(true);
    expect(pc.classificationProvenance).toBe('source');
  });

  it('refuses a missing scan, a scan with no classes, and a second clear', () => {
    const pc = cloud();
    const h = host(pc);
    expect(clearClassification(h, 'streaming')).toBe('not-loaded');
    expect(clearClassification(host(cloud(null)), 'a')).toBe('no-classification');
    clearClassification(h, 'a');
    expect(clearClassification(h, 'a')).toBe('already');
  });

  it('leaves the classification flags and the Withheld count untouched', () => {
    const withheld = encodeExtendedClassificationFlags({ withheld: true });
    const flags = Uint8Array.from(SOURCE.map((_, i) => (i % 3 === 0 ? withheld : 0)));
    const before = flags.slice();
    const pc = cloud(SOURCE, flags);
    const h = host(pc);
    const count = withheldCount(pc.classificationFlags);
    expect(count).toBeGreaterThan(0);
    clearClassification(h, 'a');
    expect([...pc.classificationFlags!]).toEqual([...before]);
    expect(withheldCount(pc.classificationFlags)).toBe(count);
    h.undo();
    expect([...pc.classificationFlags!]).toEqual([...before]);
  });
});

describe('Restore earlier classes', () => {
  it('writes the kept codes back, recorded so Undo returns to cleared', () => {
    const pc = cloud();
    const h = host(pc);
    expect(canRestoreOriginal(pc)).toBe(false);
    clearClassification(h, 'a');
    expect(canRestoreOriginal(pc)).toBe(true);
    expect(restoreOriginalClassification(h, 'a')).toBe('ok');
    expect([...pc.classification!]).toEqual(SOURCE);
    expect(pc.classificationProvenance).toBe('source');
    expect(canRestoreOriginal(pc)).toBe(false);
    h.undo();
    expect(pc.classificationProvenance).toBe('cleared');
    expect([...pc.classification!]).toEqual(SOURCE.map(() => 1));
  });

  it('brings back the file codes after lasso edits and a derive on the cleared layer', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    h.editClassification('a', (buf) => { buf[0] = 6; });
    h.derive(Uint8Array.from(SOURCE.map(() => 3)));
    expect(restoreOriginalClassification(h, 'a')).toBe('ok');
    expect([...pc.classification!]).toEqual(SOURCE);
  });

  it('has nothing to restore before a whole-scan replace', () => {
    expect(restoreOriginalClassification(host(cloud()), 'a')).toBe('no-original');
  });
});

describe('Auto-classify after a clear', () => {
  it('records the derive, so Undo returns to the cleared layer and again to the source', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    const derived = Uint8Array.from([2, 2, 2, 3, 5, 6, 1, 2, 2, 2]);
    h.derive(derived, 'olv.class.derived-heuristic@3');
    expect(pc.classificationProvenance).toBe('derived');
    expect(pc.derivedMethod).toBe('olv.class.derived-heuristic@3');
    expect([...pc.classification!]).toEqual([...derived]);
    h.undo();
    expect(pc.classificationProvenance).toBe('cleared');
    expect([...pc.classification!]).toEqual(SOURCE.map(() => 1));
    h.undo();
    expect(pc.classificationProvenance).toBe('source');
    expect([...pc.classification!]).toEqual(SOURCE);
    h.redo();
    h.redo();
    expect(pc.classificationProvenance).toBe('derived');
    expect([...pc.classification!]).toEqual([...derived]);
  });

  it('a fresh derive starts current under the frame in force', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    h.derive(Uint8Array.from(SOURCE));
    pc.markDerivedClassificationFrameInvalid();
    expect(pc.derivedClassificationFrameInvalid).toBe(true);
    h.derive(Uint8Array.from(SOURCE));
    expect(pc.derivedClassificationFrameInvalid).toBe(false);
  });
});

describe('derived codes from a replaced frame stay stale through undo and redo', () => {
  const DERIVED = Uint8Array.from(SOURCE.map(() => 2));

  it('Undo of a restore brings back stale derived codes as stale', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    h.derive(DERIVED);
    pc.markDerivedClassificationFrameInvalid(); // the frame is replaced
    expect(analysisClassification(pc, pc.positions.length)).toBeUndefined();
    restoreOriginalClassification(h, 'a');
    h.undo();
    expect(pc.classificationProvenance).toBe('derived');
    expect(pc.derivedClassificationFrameInvalid).toBe(true);
    expect(analysisClassification(pc, pc.positions.length)).toBeUndefined();
  });

  it('a frame change while cleared makes the derive behind it stale', () => {
    const pc = cloud([0, 1, 1, 0, 1, 1, 0, 1, 1, 0]);
    const h = host(pc);
    h.derive(DERIVED);
    clearClassification(h, 'a');
    pc.markDerivedClassificationFrameInvalid(); // the frame is replaced while cleared
    h.undo();
    expect(pc.classificationProvenance).toBe('derived');
    expect(pc.derivedClassificationFrameInvalid).toBe(true);
    expect(analysisClassification(pc, pc.positions.length)).toBeUndefined();
  });

  it('Redo into an older derive is stale; a fresh derive is current, and Undo returns to the stale one', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    h.derive(DERIVED);
    h.undo();
    pc.markDerivedClassificationFrameInvalid();
    h.redo();
    expect(pc.derivedClassificationFrameInvalid).toBe(true);
    h.derive(DERIVED);
    expect(pc.derivedClassificationFrameInvalid).toBe(false);
    h.undo();
    expect(pc.classificationProvenance).toBe('derived');
    expect(pc.derivedClassificationFrameInvalid).toBe(true);
    h.redo();
    expect(pc.derivedClassificationFrameInvalid).toBe(false);
  });

  it('the Viewer counts a frame change on every cloud, derived or not', () => {
    const src = readFileSync(resolve(__dirname, '../src/render/Viewer.ts'), 'utf8');
    const at = src.indexOf('  invalidateDerivedClassificationsForFrame(');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf('\n  }\n', at));
    // The mark runs before, not behind, the "derived now" check.
    expect(body).toMatch(/markDerivedClassificationFrameInvalid\(\);\s*if \(e\.cloud\.classificationIsDerived\)/);
  });
});

describe('the classifier method moves with its step', () => {
  it('Undo of a re-derive brings back the earlier method, Redo the later one', () => {
    const pc = cloud();
    const h = host(pc);
    clearClassification(h, 'a');
    // Two stand-in ids, so the step carries whatever the classifier reports.
    h.derive(Uint8Array.from(SOURCE.map(() => 2)), 'fixture.classifier-a@1');
    h.derive(Uint8Array.from(SOURCE.map(() => 3)), 'fixture.classifier-b@1');
    expect(pc.derivedMethod).toBe('fixture.classifier-b@1');
    h.undo();
    expect(pc.derivedMethod).toBe('fixture.classifier-a@1');
    h.redo();
    expect(pc.derivedMethod).toBe('fixture.classifier-b@1');
  });
});

describe('a whole-scan edit that throws', () => {
  it('leaves the provenance, the kept original and the history as they were', () => {
    const pc = cloud();
    const history = new ClassEditHistory();
    expect(() => recordClassEdit(history, pc, () => { throw new Error('edit failed'); }, 'cleared')).toThrow('edit failed');
    expect(pc.classificationProvenance).toBe('source');
    expect(pc.originalClassification).toBeUndefined();
    expect(history.canUndo).toBe(false);
  });
});

describe('undo history memory', () => {
  const N = 100_000;
  const big = (): PointCloud => new PointCloud({
    positions: new Float32Array(N * 3), origin: [0, 0, 0], sourceFormat: 'las', name: 'big',
    classification: new Uint8Array(N).fill(2),
  });

  it('a whole-scan step holds one byte per point', () => {
    const pc = big();
    const h = host(pc);
    for (let i = 0; i < 10; i++) {
      clearClassification(h, 'a');
      restoreOriginalClassification(h, 'a');
    }
    expect(h.history.depth).toBe(20);
    expect(h.history.bytes).toBe(20 * N);
    h.undo();
    h.undo();
    expect(pc.classificationProvenance).toBe('source');
    expect(pc.classification!.every((c) => c === 2)).toBe(true);
  });

  it('drops the oldest steps past the byte cap and always keeps the newest', () => {
    const pc = big();
    const history = new ClassEditHistory(50, 2.5 * N);
    const host2: ClassLayerHost = {
      getCloud: () => pc,
      editClassification: (_id, edit, to) => { recordClassEdit(history, pc, edit, to); },
    };
    clearClassification(host2, 'a');
    restoreOriginalClassification(host2, 'a');
    expect(history.depth).toBe(2);
    clearClassification(host2, 'a');
    expect(history.depth).toBe(2);
    expect(history.bytes).toBeLessThanOrEqual(2.5 * N);
    stepClassEdit(history, pc, 'undo');
    stepClassEdit(history, pc, 'undo');
    expect(pc.classificationProvenance).toBe('cleared');
    expect(stepClassEdit(history, pc, 'undo')).toBeNull();
    // Restore still reaches the codes the dropped step held.
    expect(restoreOriginalClassification(host2, 'a')).toBe('ok');
    expect(pc.classification!.every((c) => c === 2)).toBe(true);

    const tight = new ClassEditHistory(50, N / 2);
    recordClassEdit(tight, big(), (b) => b.fill(1), 'cleared');
    expect(tight.depth).toBe(1);
  });
});

describe('terrain never reads cleared or derived ground as producer ground', () => {
  it('only source class 2 is producer ground', () => {
    const pc = cloud();
    expect(producerClassifiesGround(pc, pc.classification)).toBe(true);
    const h = host(pc);
    clearClassification(h, 'a');
    // A manual class 2 on the cleared layer is still not the producer's.
    h.editClassification('a', (buf) => { buf[0] = 2; });
    expect(producerClassifiesGround(pc, pc.classification)).toBe(false);
    h.derive(Uint8Array.from(SOURCE));
    expect(producerClassifiesGround(pc, pc.classification)).toBe(false);
    restoreOriginalClassification(h, 'a');
    expect(producerClassifiesGround(pc, pc.classification)).toBe(true);
  });

  it('a cleared layer still feeds analysis its (class 1) codes', () => {
    const pc = cloud();
    clearClassification(host(pc), 'a');
    expect(analysisClassification(pc, pc.positions.length)).toBe(pc.classification);
  });
});

// ── Auto-classify gate: the explicit 'cleared' check ─────────────────────────

const derive = vi.hoisted(() => vi.fn());
vi.mock('../src/render/class/deriveClassificationAsync', () => ({ deriveClassificationAsync: derive }));
vi.mock('../src/render/class/classifierCues', () => ({ classifierOptions: () => ({}) }));

describe('runDeriveClassification', () => {
  beforeEach(() => derive.mockReset());

  async function run(pc: PointCloud | undefined, streaming = false, epoch = () => 0) {
    const { runDeriveClassification } = await import('../src/app/classifyActions');
    const toasts: string[] = [];
    const applied: { codes: Uint8Array; method?: string }[] = [];
    await runDeriveClassification({
      viewer: {
        getCloud: (id: string) => (id === 'a' ? pc : undefined),
        classificationEpoch: () => epoch(),
        applyDerivedClassification: (_id: string, codes: Uint8Array, method?: string) => {
          applied.push({ codes, method });
          return true;
        },
      } as never,
      activeId: () => (streaming ? 'stream' : 'a'),
      crsService: { crsRevision: () => 1, context: () => ({}) as never },
      toast: (m) => toasts.push(m),
      legend: { setClasses: vi.fn(), setDerivedProvenance: vi.fn(), setUnavailableNotice: vi.fn(), show: vi.fn() },
      setDerivedConfidence: vi.fn(),
      afterDerive: vi.fn(),
    });
    return { toasts, applied };
  }

  const result = {
    codes: Uint8Array.from(SOURCE.map(() => 2)),
    counts: { 2: SOURCE.length },
    confidence: 0.5,
    warnings: [],
    classifier: { method: 'olv.class.derived-heuristic@3' },
  };

  it('refuses a scan whose producer classes are live', async () => {
    const { toasts, applied } = await run(cloud());
    expect(derive).not.toHaveBeenCalled();
    expect(applied).toHaveLength(0);
    expect(toasts.join(' ')).toMatch(/carries producer classes, so they stay as they are\. Press Clear classes first/);
  });

  it('runs on a cleared scan and stamps the registry method id@version', async () => {
    const pc = cloud();
    clearClassification(host(pc), 'a');
    derive.mockResolvedValue(result);
    const { toasts, applied } = await run(pc);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(applied[0].method).toBe('olv.class.derived-heuristic@3');
    const done = toasts.at(-1)!;
    expect(done).toMatch(/heuristic, not survey-grade/);
    expect(done).toMatch(/no wires, poles, water, bridges or noise/);
    expect(done).toMatch(/buildings by a heuristic/);
  });

  it('says a streaming scan needs a fully loaded scan', async () => {
    const { toasts } = await run(undefined, true);
    expect(derive).not.toHaveBeenCalled();
    expect(toasts[0]).toBe('Classify needs a fully loaded scan and does not run on a streaming one.');
  });

  it('drops the result when the classes changed while it ran', async () => {
    const pc = cloud();
    clearClassification(host(pc), 'a');
    let epoch = 3;
    // An Undo (or a lasso, or Restore) lands while the derive is off-thread.
    derive.mockImplementation(async () => { epoch++; return result; });
    const { toasts, applied } = await run(pc, false, () => epoch);
    expect(applied).toHaveLength(0);
    expect(toasts.at(-1)).toBe('Classify · the classes changed while it ran, so it left them as they are. Run it again.');
  });
});
