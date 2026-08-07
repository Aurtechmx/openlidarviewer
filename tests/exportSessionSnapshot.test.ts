/**
 * exportSessionSnapshot.test.ts
 *
 * The `.olvsession` export read mutable scan/viewer state on both sides of a
 * lazy `import()`: the scan summary was read before it, the origin, views,
 * measurements and annotations after it. A scan opened while that import
 * resolved spliced two scans into one file — one scan's coordinate frame over
 * another scan's contents — while the export reported success.
 *
 * The fix routes the export through writeScanScopedExport: the lazy writer loads
 * FIRST, the serialise closure then takes one coherent snapshot with no await,
 * and the file is written only while the scan the export was requested for is
 * still active. These pin that contract by resolving the load slowly and
 * swapping the active scan while it resolves — the export must refuse rather
 * than write a file for a scan the user did not ask to save, and the happy path
 * must still write the captured snapshot.
 */

import { describe, it, expect } from 'vitest';
import { writeScanScopedExport } from '../src/export/exportScanIdentity';

describe('writeScanScopedExport — load first, snapshot once, verify before write', () => {
  it('loads the writer before it snapshots, then writes the snapshot when the scan holds', async () => {
    const activeId = 'scan-A';
    const order: string[] = [];
    const written: string[] = [];
    let refused = false;

    await writeScanScopedExport({
      requestedScanId: activeId,
      load: async () => {
        order.push('load');
        return { serialize: (id: string | null) => JSON.stringify({ scan: id }) };
      },
      serialize: (deps) => {
        order.push('serialize');
        return deps.serialize(activeId);
      },
      activeScanId: () => activeId,
      write: (text) => { written.push(text); },
      refuse: () => { refused = true; },
    });

    // Ordering: the lazy dependency resolves BEFORE any state is snapshotted.
    expect(order).toEqual(['load', 'serialize']);
    expect(refused).toBe(false);
    expect(written).toEqual([JSON.stringify({ scan: 'scan-A' })]);
  });

  it('refuses, and writes nothing, when the active scan changes while the writer loads', async () => {
    let activeId: string | null = 'scan-A';
    const order: string[] = [];
    const written: string[] = [];
    let refused = false;

    await writeScanScopedExport({
      requestedScanId: activeId, // 'scan-A' captured when the export was requested
      load: async () => {
        order.push('load');
        // The user opens another scan while the writer's dynamic import resolves.
        await Promise.resolve();
        activeId = 'scan-B';
        return { serialize: (id: string | null) => JSON.stringify({ scan: id }) };
      },
      serialize: (deps) => {
        order.push('serialize');
        // Reads live state, which is now scan-B — a coherent snapshot of the WRONG
        // scan. The identity backstop, not the read order, is what refuses it.
        return deps.serialize(activeId);
      },
      activeScanId: () => activeId,
      write: (text) => { written.push(text); },
      refuse: () => { refused = true; },
    });

    expect(order).toEqual(['load', 'serialize']);
    expect(refused).toBe(true);
    expect(written).toEqual([]); // no spliced file for a scan the user did not request
  });

  it('refuses when a streaming scan (null id) is opened during the load', async () => {
    let activeId: string | null = 'scan-A';
    const written: string[] = [];
    let refused = false;

    await writeScanScopedExport({
      requestedScanId: 'scan-A',
      load: async () => { activeId = null; return {}; },
      serialize: () => 'session-bytes',
      activeScanId: () => activeId,
      write: (text) => { written.push(text); },
      refuse: () => { refused = true; },
    });

    expect(refused).toBe(true);
    expect(written).toEqual([]);
  });

  it('treats a null (streaming) scan id as a value: an unchanged null still writes', async () => {
    const activeId: string | null = null;
    const written: string[] = [];

    await writeScanScopedExport({
      requestedScanId: null,
      load: async () => ({}),
      serialize: () => 'session-bytes',
      activeScanId: () => activeId,
      write: (text) => { written.push(text); },
      refuse: () => { throw new Error('an unchanged null (streaming) scan must not be refused'); },
    });

    expect(written).toEqual(['session-bytes']);
  });
});
