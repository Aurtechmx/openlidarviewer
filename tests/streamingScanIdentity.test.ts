/**
 * streamingScanIdentity.test.ts
 *
 * ROADMAP #19 — a streaming scan used to report a null shell id, and the export
 * scan-identity guard treats `sameExportTarget(null, null)` as "same target"
 * (null matches only null, deliberately). So swapping one streaming scan for
 * another mid-export was invisible: two different scans looked identical to the
 * guard. These tests pin the fix at two levels:
 *
 *   1. The mint — every streaming cloud now carries a non-null, per-session id
 *      that is distinct between scans and stable for one scan (the foundation
 *      the guard stands on).
 *   2. The read path — `ScanService.activeExportTargetId()` surfaces that id to
 *      the guard WITHOUT changing `activeId`, which stays null for streaming so
 *      no `activeId ? … : …` branch shifts (Option A's safety pin).
 *
 * The end-to-end proof that the ExportPanel now REFUSES a streaming→streaming
 * swap lives in exportPanelSnapshotIntegrity.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { nextStreamingScanId } from '../src/render/streaming/streamingScanId';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import { sameExportTarget } from '../src/export/exportScanIdentity';
import { createScanService } from '../src/app/ScanService';
import { createAppContext } from '../src/app/appContext';
import type { Viewer } from '../src/render/Viewer';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';

async function openStreaming(name: string): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }],
  });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), name);
}

describe('streaming scan id — the mint', () => {
  it('gives two different streaming scans different, non-null ids', async () => {
    const a = await openStreaming('a.copc.laz');
    const b = await openStreaming('b.copc.laz');
    expect(a.id).toBeTruthy();
    expect(b.id).toBeTruthy();
    expect(a.id).not.toBe(b.id);
  });

  it('reports the same id for the same scan on every read (stable per instance)', async () => {
    const a = await openStreaming('a.copc.laz');
    expect(a.id).toBe(a.id);
  });

  it('mints outside the static cloud_<n> namespace', () => {
    // A static scan is `cloud_<n>`; a streaming id must never collide with one,
    // because the guard compares by === and both could be read as an export
    // target. Distinct prefixes make cross-type confusion impossible.
    expect(nextStreamingScanId()).toMatch(/^streaming-scan_/);
    expect(nextStreamingScanId()).not.toMatch(/^cloud_/);
  });

  it('the guard distinguishes two streaming scans and matches one to itself', async () => {
    const a = await openStreaming('a.copc.laz');
    const b = await openStreaming('b.copc.laz');
    // The red the fix removes: before the mint, both scans reported null and the
    // guard read them as the SAME target — a swap slipped through.
    expect(sameExportTarget(null, null)).toBe(true);
    // Green: distinct ids make a swap visible, and a scan still matches itself.
    expect(sameExportTarget(a.id, b.id)).toBe(false);
    expect(sameExportTarget(a.id, a.id)).toBe(true);
  });
});

/** A viewer exposing only the two members the service reads. */
function viewerStub(streaming: () => StreamingSource | null): Viewer {
  return {
    getCloud: () => undefined,
    get streamingCloud() {
      return streaming();
    },
  } as unknown as Viewer;
}

/** A minimal streaming cloud carrying just the id the guard reads. */
function streamingWithId(id: string): StreamingSource {
  return { id } as unknown as StreamingSource;
}

describe('ScanService.activeExportTargetId — the read path', () => {
  it('returns the static activeId when a static scan is selected, and activeId is unchanged', () => {
    const svc = createScanService({ getViewer: () => viewerStub(() => null), context: createAppContext() });
    svc.setActive('cloud_3');
    expect(svc.activeExportTargetId()).toBe('cloud_3');
    expect(svc.activeId).toBe('cloud_3');
  });

  it('returns the streaming id when a streaming scan is active — while activeId stays null (safety pin)', () => {
    // A streaming scan never calls setActive, so activeId is null; the export
    // target must still be identifiable. This is the whole point of Option A:
    // activeId keeps returning null (no branch shifts), the guard reads the id.
    const svc = createScanService({
      getViewer: () => viewerStub(() => streamingWithId('streaming-scan_7')),
      context: createAppContext(),
    });
    expect(svc.activeId).toBeNull();
    expect(svc.activeExportTargetId()).toBe('streaming-scan_7');
  });

  it('distinguishes a streaming→streaming swap', () => {
    let current: StreamingSource | null = streamingWithId('streaming-scan_1');
    const svc = createScanService({ getViewer: () => viewerStub(() => current), context: createAppContext() });
    const before = svc.activeExportTargetId();
    current = streamingWithId('streaming-scan_2'); // user opened another streaming scan
    const after = svc.activeExportTargetId();
    expect(sameExportTarget(before, after)).toBe(false);
  });

  it('reports the same target for the same streaming scan (no false refusal)', () => {
    const cloud = streamingWithId('streaming-scan_9');
    const svc = createScanService({ getViewer: () => viewerStub(() => cloud), context: createAppContext() });
    expect(sameExportTarget(svc.activeExportTargetId(), svc.activeExportTargetId())).toBe(true);
  });

  it('is null when nothing identifiable is active (fail closed, not a wildcard)', () => {
    const svc = createScanService({ getViewer: () => viewerStub(() => null), context: createAppContext() });
    expect(svc.activeExportTargetId()).toBeNull();
  });

  it('prefers the static id when a static scan is selected even if a streaming cloud lingers', () => {
    // Defensive: activeId is the authoritative selection; a stale streaming
    // reference must not override an explicitly selected static scan.
    const svc = createScanService({
      getViewer: () => viewerStub(() => streamingWithId('streaming-scan_5')),
      context: createAppContext(),
    });
    svc.setActive('cloud_2');
    expect(svc.activeExportTargetId()).toBe('cloud_2');
  });
});
