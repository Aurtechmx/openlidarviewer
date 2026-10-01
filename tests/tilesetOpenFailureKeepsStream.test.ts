/**
 * tilesetOpenFailureKeepsStream.test.ts — a tileset open that fails before its
 * commit leaves the stream that was on screen.
 *
 * `attachStreamingCloud` is transactional, so a tileset refused or failing
 * before the commit never touched the stream already open. The failure path
 * closed streaming whenever the candidate had not committed, which tore down
 * that stream for a tileset that never arrived. It now tidies up only when no
 * stream was there before the open, the rule the EPT open follows.
 */

import { describe, it, expect, vi } from 'vitest';
import { openRemoteTileset } from '../src/app/openTilesetLayer';

function deps(hasStreamingCloud: boolean) {
  return {
    isLoading: () => false,
    setLoading: () => {},
    viewerReady: Promise.resolve(),
    getViewer: () => ({ hasStreamingCloud, clouds: () => [], attachStreamingCloud: vi.fn() }),
    getStreamingQuality: () => 'balanced',
    getStreamingBenchmark: () => null,
    isPhone: () => false,
    showToast: () => {},
    debug: false,
    closeStreaming: vi.fn(),
    clearOpenStaticLayers: vi.fn(),
    dropZone: { setOpening: () => {}, setCancelHandler: () => {}, setProgress: () => {}, setError: vi.fn() },
  };
}

// Refused by the entry URL check, after the Viewer is ready and before any fetch.
const REFUSED = 'http://127.0.0.1:8080/tileset.json';

describe('a tileset open that fails before its commit', () => {
  it('keeps a stream that was on screen before the open', async () => {
    const d = deps(true);
    await openRemoteTileset(REFUSED, undefined, d as never);
    expect(d.dropZone.setError).toHaveBeenCalled();
    expect(d.closeStreaming).not.toHaveBeenCalled();
  });

  it('still tidies the streaming chrome when no stream was open', async () => {
    const d = deps(false);
    await openRemoteTileset(REFUSED, undefined, d as never);
    expect(d.closeStreaming).toHaveBeenCalledTimes(1);
  });
});
