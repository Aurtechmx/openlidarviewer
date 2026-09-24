/**
 * exportPanelWrapPreviewLoadFailure.test.ts
 *
 * `ExportPanel`'s LAS 1.2 class-wrap preview is fetched lazily
 * (`loadLegacyClassGuard`, kept out of the eager shell — the class tables it
 * carries name every ASPRS code). A chunk-load failure used to reset the
 * retry flag and stop there: no re-render, so the row stayed on whatever it
 * showed before the click until an unrelated re-render happened to run
 * `_legacyClassWrap` again. This pins the fix — the failure re-renders the
 * summary immediately, with an honest "could not load" line instead of a
 * stale or blank one — by forcing `loadLegacyClassGuard` to reject. Node
 * environment via a recording DOM stub (same shape as
 * exportPanelLegacyClassWrap.test.ts).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  installFakeDom,
  classifiedCloud as cloud,
  pickFormat,
  checkRow,
  panelFor,
  exportNote as note,
  settleTicks,
} from './helpers/exportPanelHarness';

const rec = vi.hoisted(() => ({ attempts: 0 }));

vi.mock('../src/lazyChunks', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  // Always fails — deterministic, so the test can pin the failure state
  // without racing a later successful retry.
  loadLegacyClassGuard: () => {
    rec.attempts++;
    return Promise.reject(new Error('chunk failed to load'));
  },
}));

beforeAll(() => {
  installFakeDom();
});

beforeEach(() => {
  rec.attempts = 0;
});

describe('ExportPanel — LAS 1.2 class-wrap preview, chunk-load failure', () => {
  it('re-renders immediately with an honest "could not load" line, not a stale or blank one', async () => {
    const { WRAP_PREVIEW_LOAD_FAILED } = await import('../src/ui/ExportPanel');
    const root = await panelFor(cloud([2, 64, 200]));

    pickFormat(root, 'LAS 1.2');
    // Before the fetch settles the row says nothing yet — same as a real load
    // in flight.
    expect(note(root).textContent).toBe('');

    await settleTicks();

    expect(note(root).textContent).toBe(WRAP_PREVIEW_LOAD_FAILED);
    expect(note(root).className).toContain('is-warn');
    // The checkbox itself is unaffected by the preview failing to load — the
    // write gate still enforces the rule at Export regardless.
    expect(checkRow(root, 'Allow classes above 31 to wrap')?.hidden).toBe(false);
    expect(rec.attempts).toBe(1);

    // A later, unrelated re-render is what retries — not the failure's own
    // render, which would spin forever against a chunk that keeps failing.
    pickFormat(root, 'LAS 1.2');
    await settleTicks();
    expect(rec.attempts).toBe(2);
    expect(note(root).textContent).toBe(WRAP_PREVIEW_LOAD_FAILED);
  });
});
