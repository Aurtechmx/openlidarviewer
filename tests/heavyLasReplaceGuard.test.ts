/**
 * heavyLasReplaceGuard.test.ts: a large local LAS or LAZ opened out of core
 * over an open stream replaces it the way a COPC open does. It offers Save /
 * Replace / Cancel once, before any work starts, and applies the answer only
 * after the new source commits. Cancel, a cancel during the build, a failed
 * build and a failed attach leave the previous stream and all work as they
 * were. Work that is kept is stamped as the retired scan's, so a saved session
 * never writes it under the new file. Over static layers the open is additive:
 * nothing is asked and their work and saved views stay.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { openLocalHeavyLas } from '../src/app/openLocalHeavyLas';
import { OlvTileSource, PreviewCloudSource } from '../src/io/heavy/OlvTileSource';
import { requestReplace, type ReplaceRequest } from '../src/app/discardGuard';
import type { ConfirmChoice, ConfirmOptions } from '../src/ui/Modal';
import { partitionSessionWork, RETIRED_SCAN_OWNER } from '../src/app/measurementOwnership';
import type { HeavyLasBridgeEnv } from '../src/app/heavyLasTypes';
import type { OpenStreamingDeps } from '../src/app/openStreaming';
import { fakeOpfs } from './support/fakeOpfs';
import { counting, lasBytes, makeDeps, makeEnv, spyFile, type FakeWorkItem } from './support/heavyLasFakes';

function lazFixture(): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', 'multichunk.laz'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

type Format = 'las' | 'laz';

interface Setup {
  format?: Format;
  /** A COPC / EPT / tileset stream is on screen. */
  stream?: boolean;
  /** Viewer ids of the static layers open; each has stable id `stable-<id>`. */
  statics?: string[];
  /** The confirm dialog's answer; null leaves the guard unwired. */
  answer?: ConfirmChoice | null;
  /** Run while the dialog is open. */
  duringDialog?: (ctl: AbortController) => void;
  opfs?: ReturnType<typeof fakeOpfs>;
}

function setup(opts: Setup = {}) {
  const format = opts.format ?? 'las';
  const buffer = format === 'las' ? lasBytes(50_000) : lazFixture();
  const range = counting(new ArrayBufferRangeSource(buffer));
  const { deps, viewer, s } = makeDeps({ hasStreamingCloud: opts.stream ?? false });
  const statics = opts.statics ?? [];
  viewer.clouds = () => statics;
  const withStable = { ...deps, stableLayerId: (id: string) => (statics.includes(id) ? `stable-${id}` : null) };
  const ctl = new AbortController();

  // The open scan's work: one unowned measurement and annotation, and two saved views.
  const measurements = viewer.measure.getMeasurements() as FakeWorkItem[];
  const annotations = viewer.annotate.getAnnotations() as FakeWorkItem[];
  measurements.push({ id: 'm-old' });
  annotations.push({ id: 'a-old' });
  let views = 2;
  const streaming = s.streaming as OpenStreamingDeps & { bookmarks: { clear: ReturnType<typeof vi.fn> } };
  streaming.bookmarks.clear.mockImplementation(() => { views = 0; });

  const confirm = vi.fn(async (_o: ConfirmOptions): Promise<ConfirmChoice> => {
    opts.duringDialog?.(ctl);
    return opts.answer ?? 'cancel';
  });
  const saveSession = vi.fn(async () => true);
  const requests: ReplaceRequest[] = [];
  if (opts.answer !== null && opts.answer !== undefined) {
    (streaming as { replaceGuard?: OpenStreamingDeps['replaceGuard'] }).replaceGuard = (req) => {
      requests.push(req);
      return requestReplace(req, {
        work: () => ({
          measurements: measurements.length,
          annotations: annotations.length,
          views,
          classEdits: false,
          results: 0,
          pendingRecovery: false,
        }),
        saveSession,
        snapshot: async () => false,
        confirm,
      });
    };
  }

  const env: HeavyLasBridgeEnv = makeEnv(range, opts.opfs);
  const runIndex = vi.fn(env.runIndex);
  env.runIndex = runIndex;
  const file = spyFile(`heavy.${format}`, format === 'las' ? 999_999_999 : buffer.byteLength);
  const open = () => openLocalHeavyLas(file, ctl.signal, withStable, env);
  return { open, viewer, s, streaming, ctl, env, runIndex, confirm, saveSession, measurements, annotations, requests, views: () => views };
}

/** Nothing was swapped or cleared: the stream and every piece of work stand. */
function expectUntouched(t: ReturnType<typeof setup>) {
  expect(t.viewer.attachStreamingCloud).not.toHaveBeenCalled();
  expect(t.viewer.detachStreamingCloud).not.toHaveBeenCalled();
  expect(t.s.resetStreamState).not.toHaveBeenCalled();
  expect(t.viewer.measure.clear).not.toHaveBeenCalled();
  expect(t.viewer.annotate.clear).not.toHaveBeenCalled();
  expect(t.streaming.bookmarks.clear).not.toHaveBeenCalled();
  expect(t.measurements).toEqual([{ id: 'm-old' }]);
  expect(t.annotations).toEqual([{ id: 'a-old' }]);
  expect(t.views()).toBe(2);
}

describe.each<Format>(['las', 'laz'])('heavy %s open over an open stream', (format) => {
  it('offers Save / Replace / Cancel once, before the build', async () => {
    const t = setup({ format, stream: true, answer: 'cancel' });
    await t.open();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    const o = t.confirm.mock.calls[0]![0];
    expect(o.confirmLabel).toBe('Replace');
    expect(o.cancelLabel).toBe('Cancel');
    expect(o.alternateLabel).toBe('Save session, then replace');
    expect(o.message).toContain('1 measurement');
    expect(o.message).toContain('1 annotation');
    expect(o.message).toContain('2 saved views');
    expect(t.runIndex).not.toHaveBeenCalled();
  });

  it('Cancel never swaps the source or clears work', async () => {
    const t = setup({ format, stream: true, answer: 'cancel' });
    const result = await t.open();
    expect(result.status).toBe('cancelled');
    expectUntouched(t);
    expect(t.runIndex).not.toHaveBeenCalled();
  });

  it('Replace clears the work only after the new source commits', async () => {
    const t = setup({ format, stream: true, answer: 'confirm' });
    const atAttach: number[] = [];
    t.viewer.attachStreamingCloud.mockImplementation(async () => {
      atAttach.push(t.measurements.length + t.annotations.length + t.views());
    });
    const result = await t.open();
    expect(result.status).toBe('attached');
    expect(atAttach).toEqual([4]);
    expect(t.measurements).toEqual([]);
    expect(t.annotations).toEqual([]);
    expect(t.views()).toBe(0);
    const committed = t.viewer.attachStreamingCloud.mock.invocationCallOrder[0]!;
    expect(t.viewer.measure.clear.mock.invocationCallOrder[0]!).toBeGreaterThan(committed);
    expect(t.streaming.bookmarks.clear.mock.invocationCallOrder[0]!).toBeGreaterThan(committed);
  });

  it('Save session, then replace saves before the build and clears after the commit', async () => {
    const t = setup({ format, stream: true, answer: 'alternate' });
    const result = await t.open();
    expect(result.status).toBe('attached');
    expect(t.saveSession).toHaveBeenCalledTimes(1);
    expect(t.saveSession.mock.invocationCallOrder[0]!).toBeLessThan(t.runIndex.mock.invocationCallOrder[0]!);
    expect(t.measurements).toEqual([]);
    expect(t.views()).toBe(0);
  });
});

describe('heavy open over a stream: nothing changes before the commit', () => {
  it('a cancel while the dialog is open starts no build and changes nothing', async () => {
    const t = setup({ stream: true, answer: 'confirm', duringDialog: (ctl) => ctl.abort() });
    const result = await t.open();
    expect(result.status).toBe('cancelled');
    expect(t.runIndex).not.toHaveBeenCalled();
    expectUntouched(t);
  });

  it('a cancel during the build changes nothing', async () => {
    const t = setup({ stream: true, answer: 'confirm' });
    const inner = t.runIndex.getMockImplementation()!;
    t.runIndex.mockImplementation(async (req) => {
      const built = await inner(req);
      t.ctl.abort();
      return built;
    });
    const result = await t.open();
    expect(result.status).toBe('cancelled');
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expectUntouched(t);
  });

  it('a failed build changes nothing', async () => {
    const t = setup({ stream: true, answer: 'confirm' });
    t.runIndex.mockImplementation(async () => { throw new Error('index build failed'); });
    const result = await t.open();
    expect(result.status).toBe('failed');
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expectUntouched(t);
  });

  it('a failed attach keeps the previous stream and work, unstamped', async () => {
    const t = setup({ stream: true, answer: 'confirm' });
    t.viewer.attachStreamingCloud.mockImplementation(async () => { throw new Error('attach failed'); });
    const result = await t.open();
    expect(result.status).toBe('failed');
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.s.resetStreamState).not.toHaveBeenCalled();
    expect(t.viewer.measure.clear).not.toHaveBeenCalled();
    expect(t.streaming.bookmarks.clear).not.toHaveBeenCalled();
    expect(t.measurements).toEqual([{ id: 'm-old' }]);
    expect(t.annotations).toEqual([{ id: 'a-old' }]);
    expect(t.views()).toBe(2);
  });
});

describe('heavy open over a stream: a cached reopen', () => {
  it('asks once and clears only after the reopened source commits', async () => {
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    const first = setup({ opfs });
    expect((await first.open()).status).toBe('attached');
    expect(first.runIndex).toHaveBeenCalledTimes(1);

    const t = setup({ stream: true, answer: 'confirm', opfs });
    const atAttach: number[] = [];
    t.viewer.attachStreamingCloud.mockImplementation(async () => {
      atAttach.push(t.measurements.length);
    });
    const result = await t.open();
    expect(result.status).toBe('attached');
    // The second open reused the stored index: no build.
    expect(t.runIndex).not.toHaveBeenCalled();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(atAttach).toEqual([1]);
    expect(t.measurements).toEqual([]);
    expect(t.views()).toBe(0);
  });

  it('Cancel on a cached reopen attaches nothing', async () => {
    const opfs = fakeOpfs({ syncAccess: true, fileMove: true });
    expect((await setup({ opfs }).open()).status).toBe('attached');
    const t = setup({ stream: true, answer: 'cancel', opfs });
    expect((await t.open()).status).toBe('cancelled');
    expectUntouched(t);
  });
});

describe('kept work keeps its identity', () => {
  it('work left over a replaced stream is stamped as the retired scan, never the new file', async () => {
    // No question was answered (the guard is not wired), so nothing is cleared.
    const t = setup({ stream: true, answer: null });
    const result = await t.open();
    expect(result.status).toBe('attached');
    expect(t.measurements).toHaveLength(1);
    expect(t.measurements[0]!.owner).toEqual({ layerId: RETIRED_SCAN_OWNER, frame: 'project' });
    expect(t.annotations[0]!.owner).toEqual({ layerId: RETIRED_SCAN_OWNER, frame: 'project' });
    expect(t.views()).toBe(2);
    // A session saved now, with the new stream as the only scan, leaves the
    // old measurement out rather than writing it under the new file's name,
    // CRS and origin.
    const session = partitionSessionWork(t.measurements, { layers: [], activeViewerId: null });
    expect(session.keep).toEqual([]);
    expect(session.leftOut).toBe(1);
  });
});

describe('heavy open over static layers only', () => {
  it('asks nothing, keeps their work and saved views, and promotes the preview', async () => {
    const t = setup({ statics: ['s1'], answer: 'confirm' });
    const result = await t.open();
    expect(result.status).toBe('attached');
    expect(t.confirm).not.toHaveBeenCalled();
    const sources = t.viewer.attachStreamingCloud.mock.calls.map((c) => (c as unknown[])[0]);
    expect(sources[0]).toBeInstanceOf(PreviewCloudSource);
    expect(sources[1]).toBeInstanceOf(OlvTileSource);
    expect(t.streaming.bookmarks.clear).not.toHaveBeenCalled();
    expect(t.views()).toBe(2);
    expect(t.measurements.map((m) => m.id)).toEqual(['m-old']);
    // Taken while the static layer was the whole scene, so it is that layer's.
    expect(t.measurements[0]!.owner).toEqual({ layerId: 'stable-s1', frame: 'project' });
    expect(t.annotations[0]!.owner).toEqual({ layerId: 'stable-s1', frame: 'project' });
  });

  it('over an empty viewer the preview promotes without a question or a clear', async () => {
    const t = setup({ answer: 'confirm' });
    const result = await t.open();
    expect(result.status).toBe('attached');
    expect(t.confirm).not.toHaveBeenCalled();
    expect(t.viewer.attachStreamingCloud).toHaveBeenCalledTimes(2);
    expect(t.streaming.bookmarks.clear).not.toHaveBeenCalled();
    expect(t.views()).toBe(2);
  });
});

describe('heavy open over a stream with static layers open', () => {
  it('names only the stream work, and Replace keeps the static work and saved views', async () => {
    const t = setup({ stream: true, statics: ['s1'], answer: 'confirm' });
    t.measurements.push({ id: 'm-static', owner: { layerId: 'stable-s1', frame: 'project' } });
    const result = await t.open();
    expect(result.status).toBe('attached');
    expect(t.confirm).toHaveBeenCalledTimes(1);
    const o = t.confirm.mock.calls[0]![0];
    expect(o.message).toContain('1 measurement');
    expect(o.message).not.toContain('saved view');
    expect(t.measurements.map((m) => m.id)).toEqual(['m-static']);
    expect(t.annotations).toEqual([]);
    expect(t.streaming.bookmarks.clear).not.toHaveBeenCalled();
    expect(t.views()).toBe(2);
  });
});
