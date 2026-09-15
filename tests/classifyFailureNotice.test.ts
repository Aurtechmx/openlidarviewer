/**
 * classifyFailureNotice.test.ts
 *
 * A refused classification is a standing condition, not a passing hiccup: the
 * worker is gone and the cloud is too large to classify safely inline, so the
 * reason has to outlive the toast. This pins which failures reach the Classes
 * panel caption, which only toast, and which say nothing at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { reportClassifyFailure } from '../src/app/classLegendRefresh';
import { SyncFallbackRefusedError } from '../src/workers/syncFallbackRefusedError';

function surface() {
  return {
    notices: [] as Array<string | null>,
    shown: 0,
    setUnavailableNotice(message: string | null) {
      this.notices.push(message);
    },
    show() {
      this.shown++;
    },
  };
}

describe('reportClassifyFailure', () => {
  it('puts a refusal on the persistent panel caption as well as the toast', () => {
    const toasts: string[] = [];
    const legend = surface();
    const err = new SyncFallbackRefusedError({
      stage: 'classify',
      points: 4_000_000,
      limit: 1_000_000,
    });
    const shown = reportClassifyFailure(err, (m) => void toasts.push(m), legend);
    expect(shown).toBe(err.userMessage);
    expect(legend.notices).toEqual([err.userMessage]);
    expect(legend.shown).toBe(1);
    expect(toasts[0]).toContain('No classification was changed');
  });

  it('toasts an ordinary failure without claiming a standing condition', () => {
    const toasts: string[] = [];
    const legend = surface();
    reportClassifyFailure(new Error('grid build failed'), (m) => void toasts.push(m), legend);
    expect(toasts[0]).toBe('Classify · failed: grid build failed');
    expect(legend.notices).toEqual([]);
  });

  it('says nothing when the run was aborted', () => {
    const toasts: string[] = [];
    const legend = surface();
    const shown = reportClassifyFailure(
      new DOMException('Classification aborted', 'AbortError'),
      (m) => void toasts.push(m),
      legend,
    );
    expect(shown).toBeNull();
    expect(toasts).toEqual([]);
    expect(legend.notices).toEqual([]);
  });

  it('works without a panel surface', () => {
    const toast = vi.fn();
    expect(() =>
      reportClassifyFailure(
        new SyncFallbackRefusedError({ stage: 'classify', points: 2, limit: 1 }),
        toast,
      ),
    ).not.toThrow();
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
