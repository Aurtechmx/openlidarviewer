import { describe, it, expect, vi } from 'vitest';
import {
  isEptUrl,
  isAbortError,
  linkAbortSignals,
  handleRemoteEpt,
  type OpenStreamingDeps,
} from '../src/app/openStreaming';
import type { Viewer } from '../src/render/Viewer';

// ─────────────────────────────────────────────────────────────────────────────
// The pure decisions the extraction exposes — the only remote-open logic that
// can be decided without a Viewer, the network or the DOM.
// ─────────────────────────────────────────────────────────────────────────────

describe('isEptUrl — the COPC-vs-EPT routing predicate', () => {
  it('routes a plain ept.json entry point to EPT', () => {
    expect(isEptUrl('https://example.com/data/ept.json')).toBe(true);
  });

  it('routes an ept.json carrying an auth query or fragment to EPT', () => {
    // A signed dataset appends `?token=…`; a fragment can trail the path.
    expect(isEptUrl('https://example.com/data/ept.json?token=abc')).toBe(true);
    expect(isEptUrl('https://example.com/data/ept.json#frag')).toBe(true);
  });

  it('is case-insensitive on the filename', () => {
    expect(isEptUrl('https://example.com/EPT.JSON')).toBe(true);
  });

  it('routes a COPC file (and anything not ending in ept.json) to COPC', () => {
    expect(isEptUrl('https://example.com/data/scan.copc.laz')).toBe(false);
    // A path that merely contains the string but does not end in it stays COPC.
    expect(isEptUrl('https://example.com/ept.json.bak')).toBe(false);
  });

  it('falls back to a raw-string test when the URL will not parse, never throwing', () => {
    // `new URL('ept.json')` throws (no base); the raw fallback still routes it.
    expect(isEptUrl('ept.json')).toBe(true);
    expect(isEptUrl('%%% not a url %%%')).toBe(false);
  });
});

describe('isAbortError — the user-cancel classifier both remote handlers surface through', () => {
  it('recognises the platform AbortError (a fetch aborted by the linked signal)', () => {
    expect(isAbortError({ name: 'AbortError' })).toBe(true);
  });

  it("recognises HttpRangeSource's typed RangeReadError with code 'aborted'", () => {
    expect(isAbortError({ name: 'RangeReadError', code: 'aborted' })).toBe(true);
  });

  it('does NOT treat a non-abort RangeReadError as a cancel', () => {
    expect(isAbortError({ name: 'RangeReadError', code: 'timeout' })).toBe(false);
  });

  it('does NOT treat an ordinary error, or a non-object, as a cancel', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('linkAbortSignals — composing an outer Cancel with a load controller', () => {
  it('is a no-op when there is no outer signal', () => {
    const controller = new AbortController();
    const unlink = linkAbortSignals(undefined, controller);
    expect(controller.signal.aborted).toBe(false);
    expect(() => unlink()).not.toThrow();
  });

  it('aborts the controller immediately when the outer signal is already aborted', () => {
    const outer = AbortSignal.abort();
    const controller = new AbortController();
    linkAbortSignals(outer, controller);
    expect(controller.signal.aborted).toBe(true);
  });

  it('aborts the controller when the outer signal fires later, and stops after unlink', () => {
    const outer = new AbortController();
    const controller = new AbortController();
    const unlink = linkAbortSignals(outer.signal, controller);
    expect(controller.signal.aborted).toBe(false);
    outer.abort();
    expect(controller.signal.aborted).toBe(true);

    // After unlink, a fresh controller no longer tracks the (already-fired)
    // outer — the listener was detached.
    const later = new AbortController();
    const unlink2 = linkAbortSignals(new AbortController().signal, later);
    unlink();
    unlink2();
    expect(later.signal.aborted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handleRemoteEpt — the guarded remote-open decisions, driven through fakes:
// the one-load-at-a-time guard, the pure URL-validation gate, and the honest
// error surfacing when the pipeline throws.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an OpenStreamingDeps wired to spies. Only the members these guarded
 * paths reach need real behaviour; the streaming-attach collaborators are cast
 * stubs because no test here gets past the validation / chunk-load gate. A
 * `validate` override drives the pure URL gate; `loadEptRejects` simulates the
 * EPT chunk failing to load so the catch's error surfacing runs.
 */
function makeDeps(
  over: { loading?: boolean; validate?: { ok: boolean; reason?: string }; loadEptRejects?: boolean } = {},
) {
  let loading = over.loading ?? false;
  const validateRemoteEptUrl = vi.fn((_url: string) => over.validate ?? { ok: true });
  const describeRemoteEptError = vi.fn((_err: unknown, _url: string) => 'classified EPT error');
  const calls = {
    isLoading: vi.fn(() => loading),
    setLoading: vi.fn((v: boolean) => { loading = v; }),
    showToast: vi.fn(),
    setError: vi.fn(),
    setOpening: vi.fn(),
    setCancelHandler: vi.fn(),
    setProgress: vi.fn(),
    prewarmForUrl: vi.fn(),
    getViewer: vi.fn(() => ({}) as unknown as Viewer),
    closeStreaming: vi.fn(),
    validateRemoteEptUrl,
    describeRemoteEptError,
    loadEpt: vi.fn(async () => {
      if (over.loadEptRejects) throw new Error('EPT chunk failed to load');
      return { validateRemoteEptUrl, describeRemoteEptError };
    }),
  };

  const stub = <K extends keyof OpenStreamingDeps>(): OpenStreamingDeps[K] =>
    vi.fn() as unknown as OpenStreamingDeps[K];

  const deps: OpenStreamingDeps = {
    loadStreamingPointCloud: stub<'loadStreamingPointCloud'>(),
    loadCopcWorkerClient: stub<'loadCopcWorkerClient'>(),
    loadStreamingColors: stub<'loadStreamingColors'>(),
    loadEptLaszipWorkerClient: stub<'loadEptLaszipWorkerClient'>(),
    loadEpt: calls.loadEpt as unknown as OpenStreamingDeps['loadEpt'],
    loadDiagnostics: stub<'loadDiagnostics'>(),
    viewerReady: Promise.resolve(),
    getViewer: calls.getViewer,
    isLoading: calls.isLoading,
    setLoading: calls.setLoading,
    getStreamingBenchmark: () => null,
    setStreamingBenchmark: vi.fn(),
    setCoarseStableFired: vi.fn(),
    getCopcDecoder: () => null,
    setCopcDecoder: vi.fn(),
    getEptLaszipDecoder: () => null,
    setEptLaszipDecoder: vi.fn(),
    getStreamingQuality: () => 'balanced',
    setLastStreamingReportCloud: vi.fn(),
    debug: false,
    benchmark: false,
    showToast: calls.showToast,
    dropZone: {
      setError: calls.setError,
      setOpening: calls.setOpening,
      setCancelHandler: calls.setCancelHandler,
      setProgress: calls.setProgress,
    },
    stage: { hideEmptyState: vi.fn() },
    inspector: {} as unknown as OpenStreamingDeps['inspector'],
    streamingPanel: {} as unknown as OpenStreamingDeps['streamingPanel'],
    classLegendPanel: {} as unknown as OpenStreamingDeps['classLegendPanel'],
    inspectorCards: {} as unknown as OpenStreamingDeps['inspectorCards'],
    crsCoordinator: {} as unknown as OpenStreamingDeps['crsCoordinator'],
    bookmarks: { clear: vi.fn() },
    isPhone: () => false,
    closeStreaming: calls.closeStreaming,
    clearOpenStaticLayers: vi.fn(),
    startStreamingStatusPolling: vi.fn(),
    revealStreamingChrome: vi.fn(),
    revealAnalysePanel: vi.fn(),
    prewarmExportStudio: vi.fn(),
    prewarmForUrl: calls.prewarmForUrl,
    refreshViewsUI: vi.fn(),
    hideReclassifyUi: vi.fn(),
    syncInspectClassScope: vi.fn(),
    runStreamingModules: vi.fn(() => []),
  };

  return { deps, calls };
}

describe('handleRemoteEpt — the guarded remote-open decisions', () => {
  it('refuses a second open while one is in flight, without claiming the flag', async () => {
    const { deps, calls } = makeDeps({ loading: true });
    await handleRemoteEpt('https://example.com/ept.json', undefined, deps);
    expect(calls.showToast).toHaveBeenCalledWith(expect.stringContaining('Already loading'));
    // Never even loaded the EPT chunk, and never claimed the load flag.
    expect(calls.loadEpt).not.toHaveBeenCalled();
    expect(calls.setLoading).not.toHaveBeenCalled();
  });

  it('surfaces a validation failure on the drop zone and never touches the viewer', async () => {
    const { deps, calls } = makeDeps({ validate: { ok: false, reason: 'That is not an http(s) URL.' } });
    await handleRemoteEpt('ftp://nope/ept.json', undefined, deps);
    // The pure gate ran and its reason reached the user, with the ept.json hint.
    expect(calls.validateRemoteEptUrl).toHaveBeenCalledTimes(1);
    expect(calls.setError).toHaveBeenCalledWith(
      expect.stringContaining('That is not an http(s) URL.'),
    );
    expect(calls.setError.mock.calls[0][0]).toContain('ept.json');
    // Gated before any viewer / attach work.
    expect(calls.getViewer).not.toHaveBeenCalled();
    expect(calls.closeStreaming).not.toHaveBeenCalled();
    // The flag was claimed synchronously and always released in `finally`.
    expect(calls.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(calls.setLoading).toHaveBeenLastCalledWith(false);
  });

  it('claims the flag and proceeds past the guard for a valid, unclaimed open', async () => {
    const { deps, calls } = makeDeps({ validate: { ok: true }, loadEptRejects: true });
    await handleRemoteEpt('https://example.com/ept.json', undefined, deps);
    // Valid URL ⇒ the guard let it through: the flag is claimed and the EPT
    // chunk pre-warm + load both fire.
    expect(calls.setLoading).toHaveBeenNthCalledWith(1, true);
    expect(calls.prewarmForUrl).toHaveBeenCalledTimes(1);
    expect(calls.loadEpt).toHaveBeenCalledTimes(1);
  });

  it('surfaces a chunk-load failure honestly, tidies up, and releases the flag', async () => {
    // The EPT chunk itself fails to load, so `eptUrlMod` never arrives and the
    // catch falls back to the generic classifier — the honest error path.
    const { deps, calls } = makeDeps({ validate: { ok: true }, loadEptRejects: true });
    await handleRemoteEpt('https://example.com/ept.json', undefined, deps);
    expect(calls.setError).toHaveBeenCalledTimes(1);
    // A failed open leaves no scan — the stream is torn down.
    expect(calls.closeStreaming).toHaveBeenCalledTimes(1);
    // And the one-load flag is always released.
    expect(calls.setLoading).toHaveBeenLastCalledWith(false);
  });
});
