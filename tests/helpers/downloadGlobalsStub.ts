/**
 * downloadGlobalsStub.ts — the DOM globals a report download touches, for tests
 * that run `generateReportPdf` in the node environment.
 *
 * `triggerDownload` creates an anchor, appends it and asks `URL` for an object
 * URL. Node has no DOM, so this stubs exactly those globals for the file's
 * suite. Fake timers keep the deferred URL revoke from firing after the stubs
 * are torn down.
 */

import { afterAll, beforeAll, vi } from 'vitest';

/** Register suite-level hooks that stub the download globals; `blobUrl` is what `createObjectURL` returns. */
export function stubDownloadGlobals(blobUrl: string): void {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      createElement: () => ({ href: '', download: '', click() {}, remove() {} }),
      body: { appendChild() {} },
    });
    const u = globalThis.URL as unknown as Record<string, unknown>;
    u.createObjectURL = () => blobUrl;
    u.revokeObjectURL = () => {};
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const u = globalThis.URL as unknown as Record<string, unknown>;
    delete u.createObjectURL;
    delete u.revokeObjectURL;
  });
}
