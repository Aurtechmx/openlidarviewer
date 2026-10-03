// What these tests would catch:
//
//  - A session imported on an empty viewer left waiting after Close or a
//    reset, so a later scan open applied a session the user had closed.
//  - A streamed first open leaving the session waiting, so a later additive
//    static open took it and dropped it without applying.
//  - A streamed open dropping the session without telling the user.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  clearPendingSessionRestore,
  dropPendingSessionForStream,
  markPendingSessionRestore,
  takePendingSessionRestore,
} from '../src/app/pendingSessionRestore';
import { activateCommittedStreamingCloud, type OpenStreamingDeps } from '../src/app/openStreaming';

const file = (): File => new File(['{}'], 'site.olvsession');

describe('pending session restore', () => {
  it('is taken once', () => {
    const f = file();
    markPendingSessionRestore(f);
    expect(takePendingSessionRestore()).toBe(f);
    expect(takePendingSessionRestore()).toBeNull();
  });

  it('is cleared on reset', () => {
    markPendingSessionRestore(file());
    clearPendingSessionRestore();
    expect(takePendingSessionRestore()).toBeNull();
  });

  it('the reset that Close and removing the last scan run clears it', () => {
    const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    const body = main.slice(main.indexOf('function resetToEmptyState(): void {'));
    expect(body.slice(0, body.indexOf('\n}\n'))).toContain('clearPendingSessionRestore();');
  });
});

describe('a streamed open while a session waits', () => {
  const deps = (showToast: (m: string) => void): OpenStreamingDeps => {
    const any = () => vi.fn();
    return new Proxy({ showToast, stage: { hideEmptyState: any() }, inspectorCards: { refreshProvenanceFromStreaming: any() } } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : new Proxy(vi.fn(), { get: () => vi.fn() })),
    }) as unknown as OpenStreamingDeps;
  };

  it('drops the session and says it was not applied', () => {
    markPendingSessionRestore(file());
    const toast = vi.fn();
    activateCommittedStreamingCloud({ kind: 'copc', name: 'scan.copc.laz', sourcePointCount: 1, crs: () => null }, deps(toast));
    expect(takePendingSessionRestore()).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('was not applied'));
  });

  it('says nothing when no session waits', () => {
    const toast = vi.fn();
    dropPendingSessionForStream(toast);
    expect(toast).not.toHaveBeenCalled();
  });
});
