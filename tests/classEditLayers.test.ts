/**
 * Class edits at risk are read over the layers an action removes, not the
 * active selection. Close scan and an exclusive streaming open remove every
 * static layer; the layer row's remove control removes one.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  editedLayerNames, editedStaticLayerNames, keepClassEditsLine, layerHasClassEdits, staticClassEditWork,
  type ClassEditLayerReader,
} from '../src/app/classEditLayers';
import { createCloseScanGuard, describeDiscardableWork, type DiscardableWork } from '../src/app/closeScanGuard';
import { requestReplace } from '../src/app/discardGuard';
import type { ConfirmChoice, ConfirmOptions } from '../src/ui/Modal';

interface FakeLayer {
  name: string;
  provenance: string;
  epoch: number;
  hidden?: boolean;
  locked?: boolean;
}

/** A viewer holding static layers. `active` is what the old check read; nothing here should. */
function fakeViewer(layers: Record<string, FakeLayer>): ClassEditLayerReader & { active: string } {
  const ids = Object.keys(layers);
  return {
    active: ids[ids.length - 1] ?? '',
    clouds: () => ids,
    getCloud: (id) => {
      const l = layers[id];
      return l ? { name: l.name, classificationProvenance: l.provenance } : undefined;
    },
    classificationEpoch: (id) => layers[id]?.epoch ?? 0,
  };
}

const NO_WORK: DiscardableWork = { measurements: 0, annotations: 0, views: 0, classEdits: false, results: 0, pendingRecovery: false };

/** Edited LAS A opened first, then clean PLY B, which is now active. */
const editedThenClean = () => fakeViewer({
  a: { name: 'a.las', provenance: 'source', epoch: 2 },
  b: { name: 'b.ply', provenance: 'none', epoch: 0 },
});

describe('class edits over a layer set', () => {
  it('finds an edited layer that is not the active one', () => {
    const v = editedThenClean();
    expect(v.active).toBe('b');
    expect(editedStaticLayerNames(v)).toEqual(['a.las']);
    expect(staticClassEditWork(v)).toEqual({ classEdits: true, classEditLayers: ['a.las'] });
  });

  it('counts a hidden or locked edited layer', () => {
    const v = fakeViewer({
      a: { name: 'a.las', provenance: 'source', epoch: 1, hidden: true },
      c: { name: 'c.las', provenance: 'derived', epoch: 0, locked: true },
      b: { name: 'b.ply', provenance: 'source', epoch: 0 },
    });
    expect(editedStaticLayerNames(v)).toEqual(['a.las', 'c.las']);
  });

  it('reads provenance and edit epoch per layer', () => {
    const v = fakeViewer({
      src: { name: 's', provenance: 'source', epoch: 0 },
      edited: { name: 'e', provenance: 'source', epoch: 3 },
      derived: { name: 'd', provenance: 'derived', epoch: 0 },
      none: { name: 'n', provenance: 'none', epoch: 5 },
    });
    expect(['src', 'edited', 'derived', 'none'].map((id) => layerHasClassEdits(id, v))).toEqual([false, true, true, false]);
    expect(layerHasClassEdits('missing', v)).toBe(false);
    expect(editedStaticLayerNames(null)).toEqual([]);
  });

  it('counts only the removed layer for a single-layer removal', () => {
    const v = editedThenClean();
    expect(editedLayerNames(['b'], v)).toEqual([]);
    expect(layerHasClassEdits('b', v)).toBe(false);
    expect(editedLayerNames(['a'], v)).toEqual(['a.las']);
  });

  it('names the layers and points to the LAS export, not the session', () => {
    const one = keepClassEditsLine(['a.las']);
    expect(one).toContain('export a.las as LAS');
    expect(one).toContain('does not store class edits');
    expect(keepClassEditsLine(['a.las', 'c.las'])).toContain('each of these layers as LAS');
    expect(describeDiscardableWork({ ...NO_WORK, classEdits: true, classEditLayers: ['a.las', 'c.las', 'd.laz'] }))
      .toBe('class edits on a.las, c.las and d.laz');
  });
});

describe('guards see edits on a layer that is not active', () => {
  it('asks before Close, names the layer, and Cancel closes nothing', async () => {
    const v = editedThenClean();
    const close = vi.fn();
    const saveSession = vi.fn(async () => true);
    const confirm = vi.fn(async (_o: ConfirmOptions): Promise<ConfirmChoice> => 'cancel');
    const guard = createCloseScanGuard({ work: () => ({ ...NO_WORK, ...staticClassEditWork(v) }), close, saveSession, confirm });
    expect(await guard()).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    const o = confirm.mock.calls[0]![0];
    expect(o.message).toContain('class edits on a.las');
    expect(o.message).toContain('export a.las as LAS');
    expect(o.alternateLabel).toBeUndefined(); // a session save would not keep class edits
    expect(close).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('asks before an exclusive streaming open, and Cancel keeps everything', async () => {
    const v = editedThenClean();
    const snapshot = vi.fn(async () => true);
    const saveSession = vi.fn(async () => true);
    const confirm = vi.fn(async (_o: ConfirmOptions): Promise<ConfirmChoice> => 'cancel');
    const outcome = await requestReplace(
      { kind: 'scan', name: 'survey.copc.laz' },
      { work: () => ({ ...NO_WORK, ...staticClassEditWork(v) }), confirm, saveSession, snapshot },
    );
    expect(outcome).toBe('cancel');
    const o = confirm.mock.calls[0]![0];
    expect(o.message).toContain('class edits on a.las');
    expect(o.message).toContain('export a.las as LAS');
    expect(o.alternateLabel).toBeUndefined();
    expect(snapshot).not.toHaveBeenCalled();
    expect(saveSession).not.toHaveBeenCalled();
  });

  it('does not offer the session as the way to keep class edits when other work is saved with it', async () => {
    const v = editedThenClean();
    const confirm = vi.fn(async (_o: ConfirmOptions): Promise<ConfirmChoice> => 'cancel');
    await requestReplace(
      { kind: 'scan', name: 'survey.copc.laz' },
      { work: () => ({ ...NO_WORK, measurements: 1, ...staticClassEditWork(v) }), confirm, saveSession: async () => true },
    );
    const msg = confirm.mock.calls[0]![0].message;
    expect(msg).toContain('Save the current session first to keep the measurements, annotations and views.');
    expect(msg).toContain('does not store class edits');
  });
});
