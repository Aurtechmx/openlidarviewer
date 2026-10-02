/**
 * heavyLasStreamReset.test.ts: a heavy local LAS/LAZ that replaces an open
 * COPC, EPT or 3D Tiles stream drops that stream's class tally, report cloud
 * and confidence once its attach commits, and keeps them on cancel or failure.
 * Static layers are not cleared on this path.
 */
import { describe, it, expect } from 'vitest';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { openLocalHeavyLas } from '../src/app/openLocalHeavyLas';
import { counting, lasBytes, makeDeps, makeEnv, spyFile } from './support/heavyLasFakes';
import { LoadCancelledError } from '../src/io/loadFile';

async function openHeavy(attach?: (signal: AbortSignal, ctl: AbortController) => Promise<void>) {
  const range = counting(new ArrayBufferRangeSource(lasBytes(50_000)));
  // A stream is already on screen (the COPC scan), so no preview attaches.
  const { deps, viewer, s } = makeDeps({ hasStreamingCloud: true });
  const ctl = new AbortController();
  if (attach) viewer.attachStreamingCloud.mockImplementation(() => attach(ctl.signal, ctl));
  // A COPC stream is open: its node ids and classes are in the tally.
  s.ledger.record('0-0-0-0', new Uint8Array([6, 6, 5]));
  const file = spyFile('heavy.las', 999_999_999);
  const result = await openLocalHeavyLas(file, ctl.signal, deps, makeEnv(range));
  return { result, s };
}

describe('heavy LAS over an open stream', () => {
  it('drops the previous stream state once the attach commits', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');
    expect(s.resetStreamState).toHaveBeenCalledTimes(1);
    // The reset runs before the new scan publishes its report.
    expect(s.resetStreamState.mock.invocationCallOrder[0]).toBeLessThan(
      s.setLastStreamingReportCloud.mock.invocationCallOrder[0],
    );
  });

  it('keeps the previous stream state when the open is cancelled', async () => {
    const { result, s } = await openHeavy(async (_signal, ctl) => {
      ctl.abort();
      throw new LoadCancelledError();
    });
    expect(result.status).toBe('cancelled');
    expect(s.resetStreamState).not.toHaveBeenCalled();
    expect(s.ledger.size()).toBe(1);
  });

  it('keeps the previous stream state when the attach fails', async () => {
    const { result, s } = await openHeavy(async () => {
      throw new Error('attach failed');
    });
    expect(result.status).not.toBe('attached');
    expect(s.resetStreamState).not.toHaveBeenCalled();
    expect(s.ledger.size()).toBe(1);
  });

  it('shows only the heavy file classes in the legend tally after COPC', async () => {
    const { result, s } = await openHeavy();
    expect(result.status).toBe('attached');
    // The heavy store reuses the node id the COPC scan used.
    const fresh = s.ledger.record('0-0-0-0', new Uint8Array([2, 2]));
    expect(fresh).not.toBeNull();
    expect([...s.ledger.aggregate()]).toEqual([[2, 2]]);
  });
});
