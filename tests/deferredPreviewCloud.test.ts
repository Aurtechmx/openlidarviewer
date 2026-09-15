/**
 * deferredPreviewCloud.test.ts
 *
 * The stand-in a load shows arrives through a lazy chunk, and chunks can land
 * before that module does. These tests pin the holding rule: everything is
 * replayed in order once the module is there, a dispose that comes first
 * builds nothing, and a built layer is released exactly once. The gate stands
 * in for the network. A fake starter records what reaches the layer.
 */
import { describe, it, expect, vi } from 'vitest';
import { deferredPreviewCloud } from '../src/app/openScan';
import type { PreviewChunk } from '../src/io/loadLas';

const chunk = (n: number): PreviewChunk => ({
  positions: new Float32Array([n, n, n]),
  expectedPoints: 10,
  frame: null,
} as unknown as PreviewChunk);

function harness() {
  const appended: PreviewChunk[] = [];
  const disposed = vi.fn();
  const started = vi.fn((_v: unknown, first: PreviewChunk) => {
    appended.push(first);
    return { append: (c: PreviewChunk) => { appended.push(c); }, dispose: disposed };
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const load = () => gate.then(() => ({ startPreviewCloud: started as never }));
  return { appended, disposed, started, release, load };
}

describe('deferredPreviewCloud', () => {
  it('holds chunks until the module lands, then replays them in order', async () => {
    // Two chunks arrive before the gate opens. Neither may reach the layer
    // early, and the third, sent after, goes straight through.
    const h = harness();
    const handle = deferredPreviewCloud({} as never, chunk(1), 10, h.load as never);
    handle.append(chunk(2));
    expect(h.started).not.toHaveBeenCalled();
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.started).toHaveBeenCalledTimes(1);
    handle.append(chunk(3));
    expect(h.appended.map((c) => c.positions[0])).toEqual([1, 2, 3]);
  });

  it('never builds the layer when disposed before the module lands', async () => {
    // A cancel can beat the chunk. Nothing is built, so nothing is released.
    const h = harness();
    const handle = deferredPreviewCloud({} as never, chunk(1), 10, h.load as never);
    handle.dispose();
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.started).not.toHaveBeenCalled();
    expect(h.disposed).not.toHaveBeenCalled();
  });

  it('disposes the built layer once', async () => {
    const h = harness();
    const handle = deferredPreviewCloud({} as never, chunk(1), 10, h.load as never);
    h.release();
    await new Promise((r) => setTimeout(r, 0));
    handle.dispose();
    handle.dispose();
    expect(h.disposed).toHaveBeenCalledTimes(1);
  });
});
