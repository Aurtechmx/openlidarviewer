import { describe, it, expect, vi } from 'vitest';
import {
  isEptUrl,
  isAbortError,
  linkAbortSignals,
  handleRemoteEpt,
  openStreamingCopc,
  shouldTidyFailedStreamingOpen,
  shouldDropCandidateOnPostCommitCancel,
  activateCommittedStreamingCloud,
  type OpenStreamingDeps,
} from '../src/app/openStreaming';
import type { Viewer } from '../src/render/Viewer';
import type { RangeSource } from '../src/io/range/RangeSource';
import { RangeReadError } from '../src/io/range/RangeSource';
import { EptTimeoutError } from '../src/io/ept/eptTransport';

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

  // Regression: the three streaming outcomes must classify distinctly against the
  // ACTUAL error types each layer throws, not just hand-built shapes.
  it('treats the octree user-cancel throw (a DOMException AbortError) as a cancel', () => {
    expect(isAbortError(new DOMException('Hierarchy load aborted', 'AbortError'))).toBe(true);
  });

  it('does NOT treat an internal EPT timeout (EptTimeoutError) as a cancel', () => {
    expect(isAbortError(new EptTimeoutError('EPT request timed out after 20000 ms for https://x/ept.json'))).toBe(false);
  });

  it('does NOT treat a COPC RangeReadError timeout as a cancel, but does treat its aborted', () => {
    expect(isAbortError(new RangeReadError('timeout', 'timed out'))).toBe(false);
    expect(isAbortError(new RangeReadError('aborted', 'Range read aborted'))).toBe(true);
  });

  it('does NOT treat a transport / HTTP failure as a cancel', () => {
    expect(isAbortError(new RangeReadError('transport', 'could not reach host'))).toBe(false);
    expect(isAbortError(new Error('EPT hierarchy fetch failed (500 Err) for https://x'))).toBe(false);
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
  const validateRemoteEptUrl = vi.fn((url: string) => over.validate ?? { ok: true, url });
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
    exportPanel: { setImageExportEnabled: () => {}, setImageExportAvailability: () => {}, setStreamingMode: () => {} } as unknown as OpenStreamingDeps['exportPanel'],
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

// ─────────────────────────────────────────────────────────────────────────────
// Transactional streaming replacement — the ownership decisions (blocker #4).
// The current valid scene must survive any failed or cancelled replacement.
// ─────────────────────────────────────────────────────────────────────────────

describe('shouldTidyFailedStreamingOpen — a failed open never blanks a valid scene', () => {
  it('keeps a committed candidate (it is now the valid scene)', () => {
    expect(shouldTidyFailedStreamingOpen(true, false)).toBe(false);
    expect(shouldTidyFailedStreamingOpen(true, true)).toBe(false);
  });

  it('keeps a prior streaming scene when the candidate failed before commit (blocker #4A)', () => {
    // streaming A on screen, candidate B throws during build → A is intact
    // (attach is transactional), so the failure handler must NOT close it.
    expect(shouldTidyFailedStreamingOpen(false, true)).toBe(false);
  });

  it('tidies up only a first / static-replacing open that never committed', () => {
    // No prior streaming scene and nothing committed: a half-built candidate is
    // the only streaming residue, so closing it is correct and blanks nothing.
    expect(shouldTidyFailedStreamingOpen(false, false)).toBe(true);
  });
});

describe('shouldDropCandidateOnPostCommitCancel — a post-commit cancel never blanks the viewer', () => {
  it('drops the fresh stream back to still-present static layers', () => {
    expect(shouldDropCandidateOnPostCommitCancel(true, true)).toBe(true);
  });

  it('keeps a streaming→streaming candidate (the old scene is already gone)', () => {
    // No static layers to fall back to: dropping the committed candidate would
    // blank the viewer, so the late cancel keeps it.
    expect(shouldDropCandidateOnPostCommitCancel(false, true)).toBe(false);
  });

  it('does nothing when there was no cancel', () => {
    expect(shouldDropCandidateOnPostCommitCancel(true, false)).toBe(false);
    expect(shouldDropCandidateOnPostCommitCancel(false, false)).toBe(false);
  });
});

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

  it('a manifest that stalls past the internal timeout surfaces as a timeout, not a silent cancel', async () => {
    vi.useFakeTimers();
    // A fetch that never answers on its own; it rejects only when its signal
    // aborts (a server that accepts the connection but then hangs).
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
        new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal;
          sig?.addEventListener(
            'abort',
            () => reject(sig.reason ?? new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { deps, calls } = makeDeps({ validate: { ok: true } });
      // The manifest path destructures these off the lazy EPT module before it
      // fetches; expose them, including the typed timeout the fix now throws.
      (calls.loadEpt as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        validateRemoteEptUrl: calls.validateRemoteEptUrl,
        describeRemoteEptError: calls.describeRemoteEptError,
        parseEptMetadata: vi.fn(),
        EptStreamingPointCloud: vi.fn(),
        EptChunkDecoder: vi.fn(),
        EptTimeoutError,
        eptUrlSearch: vi.fn(() => ''),
        createEptTransport: vi.fn(),
      });
      const p = handleRemoteEpt('https://example.com/ept.json', undefined, deps);
      // Fire the internal 20 s manifest deadline while the fetch is still hanging.
      await vi.advanceTimersByTimeAsync(20_000);
      await p;
      // The stall was surfaced as an error, NOT swallowed as a cancel...
      expect(calls.setError).toHaveBeenCalled();
      // ...and classified as a timeout: the error handed to the describer carries
      // code 'timeout', so isAbortError never read it as a user cancel.
      const errArg = calls.describeRemoteEptError.mock.calls.at(-1)?.[0];
      expect(errArg).toBeInstanceOf(EptTimeoutError);
      expect((errArg as { code?: string }).code).toBe('timeout');
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// openStreamingCopc — transactional replacement (gate F4). A COPC candidate
// that clears the range probe but fails to PARSE (StreamingPointCloud.open
// rejects) must not tear the current scene down: the prior-scan teardown is
// deferred to attachStreamingCloud's own build-then-detach, which never runs
// when the open rejects. This is the seam that keeps a range-capable host
// serving a malformed COPC from blanking the scene the user still has.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an OpenStreamingDeps for the COPC open path, wired far enough to run
 * `openStreamingCopc` end to end. `openRejects` makes `StreamingPointCloud.open`
 * reject (a malformed COPC that passed the range probe); the spies let the tests
 * assert whether the exclusive-scene teardown (clear static layers + attach the
 * replacement) ran — and it must run ONLY once the candidate has opened.
 */
function makeCopcDeps(over: { openRejects?: boolean; attachRejects?: boolean; priorStreamingCloud?: boolean; staticLayers?: number } = {}) {
  // A structurally-complete streaming cloud so the post-open panel/inspector
  // wiring runs without a stray undefined-access aborting the flow early.
  const cloud = {
    kind: 'copc' as const,
    name: 'scan.copc.laz',
    sourcePointCount: 1000,
    metadata: {
      header: { min: [0, 0, 0], max: [10, 10, 5], pointDataRecordFormat: 6 },
      info: { spacing: 0.05 },
    },
    maxDepth: () => 4,
    octree: { nodes: () => [] as unknown[] },
    crs: () => null,
  };
  const openSpy = vi.fn(async () => {
    if (over.openRejects) throw new Error('malformed COPC hierarchy');
    return cloud;
  });
  const attachStreamingCloud = vi.fn(async () => {
    if (over.attachRejects) throw new Error('GPU mesh build failed');
  });
  const viewer = {
    ready: Promise.resolve(),
    hasStreamingCloud: over.priorStreamingCloud ?? true,
    // Static layers present before the open — drives `replacingStatic`. Default
    // 0 so the streaming→streaming cases below exercise the no-fallback path.
    clouds: () => Array.from({ length: over.staticLayers ?? 0 }, () => ({})),
    attachStreamingCloud,
    setMode: vi.fn(),
    frameAll: vi.fn(),
    availableImageExportModes: () => [],
  } as unknown as Viewer;

  const calls = {
    openSpy,
    attachStreamingCloud,
    closeStreaming: vi.fn(),
    clearOpenStaticLayers: vi.fn(),
    // Post-commit activation spies (blockers #2/#3): a failed open must never fire these.
    hideEmptyState: vi.fn(),
    refreshProvenance: vi.fn(),
    refreshCrs: vi.fn(),
  };

  const stub = <K extends keyof OpenStreamingDeps>(): OpenStreamingDeps[K] =>
    vi.fn() as unknown as OpenStreamingDeps[K];

  const deps: OpenStreamingDeps = {
    loadStreamingPointCloud: vi.fn(async () => ({
      StreamingPointCloud: { open: openSpy },
    })) as unknown as OpenStreamingDeps['loadStreamingPointCloud'],
    loadCopcWorkerClient: vi.fn(async () => ({
      CopcWorkerClient: class {},
    })) as unknown as OpenStreamingDeps['loadCopcWorkerClient'],
    loadStreamingColors: vi.fn(async () => ({
      availableStreamingModes: () => [],
      defaultStreamingMode: () => 'rgb',
    })) as unknown as OpenStreamingDeps['loadStreamingColors'],
    loadEptLaszipWorkerClient: stub<'loadEptLaszipWorkerClient'>(),
    loadEpt: stub<'loadEpt'>(),
    loadDiagnostics: stub<'loadDiagnostics'>(),
    viewerReady: Promise.resolve(),
    getViewer: () => viewer,
    isLoading: () => false,
    setLoading: vi.fn(),
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
    showToast: vi.fn(),
    dropZone: {
      setError: vi.fn(),
      setOpening: vi.fn(),
      setCancelHandler: vi.fn(),
      setProgress: vi.fn(),
    },
    stage: { hideEmptyState: calls.hideEmptyState },
    inspector: {
      element: { classList: { remove: vi.fn() } },
      setStreamingMode: vi.fn(),
      setDetail: vi.fn(),
      setReport: vi.fn(),
    } as unknown as OpenStreamingDeps['inspector'],
    exportPanel: {
      setImageExportEnabled: vi.fn(),
      setImageExportAvailability: vi.fn(),
      setStreamingMode: vi.fn(),
    } as unknown as OpenStreamingDeps['exportPanel'],
    streamingPanel: {
      setPhase: vi.fn(),
      show: vi.fn(),
      setColorModes: vi.fn(),
      setQuality: vi.fn(),
      setSummary: vi.fn(),
    } as unknown as OpenStreamingDeps['streamingPanel'],
    classLegendPanel: {
      setClasses: vi.fn(),
      hide: vi.fn(),
      getVisibility: () => ({ isFiltered: () => false }),
    } as unknown as OpenStreamingDeps['classLegendPanel'],
    inspectorCards: {
      refreshProvenanceFromStreaming: calls.refreshProvenance,
      refreshDatasetIntelligenceFromStreamingCloud: vi.fn(),
    } as unknown as OpenStreamingDeps['inspectorCards'],
    crsCoordinator: {
      refreshCrsForStreamingCloud: calls.refreshCrs,
    } as unknown as OpenStreamingDeps['crsCoordinator'],
    bookmarks: { clear: vi.fn() },
    isPhone: () => false,
    closeStreaming: calls.closeStreaming,
    clearOpenStaticLayers: calls.clearOpenStaticLayers,
    startStreamingStatusPolling: vi.fn(),
    revealStreamingChrome: vi.fn(),
    revealAnalysePanel: vi.fn(),
    prewarmExportStudio: vi.fn(),
    prewarmForUrl: vi.fn(),
    refreshViewsUI: vi.fn(),
    hideReclassifyUi: vi.fn(),
    syncInspectClassScope: vi.fn(),
    runStreamingModules: vi.fn(() => []),
  };

  return { deps, calls };
}

describe('openStreamingCopc — transactional replacement (gate F4)', () => {
  it('leaves the prior streaming scene intact when the candidate fails to open', async () => {
    const { deps, calls } = makeCopcDeps({ openRejects: true, priorStreamingCloud: true });
    await expect(
      openStreamingCopc({} as RangeSource, 'scan.copc.laz', new AbortController().signal, deps),
    ).rejects.toThrow(/malformed COPC/i);

    // The open was reached (so we're past the range probe) …
    expect(calls.openSpy).toHaveBeenCalledTimes(1);
    // … but it REJECTED, and the prior scene's teardown is deferred to
    // attachStreamingCloud — which never ran. So nothing was torn down: no
    // detach of the streaming cloud, no clearing of static layers.
    expect(calls.attachStreamingCloud).not.toHaveBeenCalled();
    expect(calls.closeStreaming).not.toHaveBeenCalled();
    expect(calls.clearOpenStaticLayers).not.toHaveBeenCalled();
  });

  it('tears down (attaches the replacement, clears static layers) only once the candidate opens', async () => {
    const { deps, calls } = makeCopcDeps({ openRejects: false, priorStreamingCloud: true });
    await openStreamingCopc({} as RangeSource, 'scan.copc.laz', new AbortController().signal, deps);

    // A candidate that DOES open reaches the exclusive-scene teardown: static
    // layers cleared and the replacement attached (attach's own detach retires
    // the prior streaming cloud) — the "after the candidate opened" ordering.
    expect(calls.openSpy).toHaveBeenCalledTimes(1);
    expect(calls.clearOpenStaticLayers).toHaveBeenCalledTimes(1);
    expect(calls.attachStreamingCloud).toHaveBeenCalledTimes(1);
  });

  it('preserves the static scene when the ATTACH itself fails (pass-7 A)', async () => {
    // The candidate opens, but attachStreamingCloud throws (e.g. GPU mesh build).
    // Because the static-layer clear is deferred until AFTER a successful attach,
    // a failed attach must leave the static scene intact — not a blank viewer.
    const { deps, calls } = makeCopcDeps({ attachRejects: true, priorStreamingCloud: true });
    await expect(
      openStreamingCopc({} as RangeSource, 'scan.copc.laz', new AbortController().signal, deps),
    ).rejects.toThrow(/GPU mesh build failed/);
    expect(calls.attachStreamingCloud).toHaveBeenCalledTimes(1);
    // The attach threw BEFORE the clear ran, so the static layers survive.
    expect(calls.clearOpenStaticLayers).not.toHaveBeenCalled();
  });

  it('hands the load-cancel signal to attachStreamingCloud so it can gate its own commit (#4C)', async () => {
    const { deps, calls } = makeCopcDeps({ priorStreamingCloud: true });
    const signal = new AbortController().signal;
    await openStreamingCopc({} as RangeSource, 'scan.copc.laz', signal, deps);
    expect(calls.attachStreamingCloud).toHaveBeenCalledTimes(1);
    // The 6th positional argument is the AbortSignal — the seam the pre-commit
    // gate reads to keep the previous scene on a streaming→streaming cancel.
    expect((calls.attachStreamingCloud.mock.calls[0] as unknown[])[5]).toBe(signal);
  });

  it('a cancel before the candidate opens tears nothing down (early guard)', async () => {
    const { deps, calls } = makeCopcDeps({ priorStreamingCloud: true, staticLayers: 2 });
    const ac = new AbortController();
    ac.abort();
    await expect(
      openStreamingCopc({} as RangeSource, 'scan.copc.laz', ac.signal, deps),
    ).rejects.toThrow();
    // Cancelled before the exclusive-scene teardown: no attach, no close, no clear.
    expect(calls.attachStreamingCloud).not.toHaveBeenCalled();
    expect(calls.closeStreaming).not.toHaveBeenCalled();
    expect(calls.clearOpenStaticLayers).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-commit application-metadata activation (blockers #2 and #3). A candidate's
// CRS / provenance / usage must become authoritative ONLY after the scene commits.
// ─────────────────────────────────────────────────────────────────────────────

describe('activateCommittedStreamingCloud — the shared publish seam', () => {
  it('publishes empty-state, provenance and CRS for a committed cloud', () => {
    const { deps, calls } = makeCopcDeps();
    activateCommittedStreamingCloud(
      { kind: 'ept', name: 'site.ept', sourcePointCount: 9, crs: () => null },
      deps,
    );
    expect(calls.hideEmptyState).toHaveBeenCalledTimes(1);
    expect(calls.refreshProvenance).toHaveBeenCalledTimes(1);
    // This is how EPT reaches CrsService at all (blocker #2).
    expect(calls.refreshCrs).toHaveBeenCalledTimes(1);
  });
});

describe('openStreamingCopc — metadata is published only AFTER commit (blocker #3)', () => {
  it('a successful open publishes CRS + provenance exactly once', async () => {
    const { deps, calls } = makeCopcDeps({ priorStreamingCloud: true });
    await openStreamingCopc({} as RangeSource, 'scan.copc.laz', new AbortController().signal, deps);
    expect(calls.attachStreamingCloud).toHaveBeenCalledTimes(1);
    expect(calls.refreshCrs).toHaveBeenCalledTimes(1);
    expect(calls.refreshProvenance).toHaveBeenCalledTimes(1);
  });

  it('an ATTACH failure never publishes the candidate CRS or provenance', async () => {
    // Streaming A active; candidate B fails to attach. B's CRS/provenance must NOT
    // become authoritative — that was the silent visible-A / CRS-B corruption.
    const { deps, calls } = makeCopcDeps({ attachRejects: true, priorStreamingCloud: true });
    await expect(
      openStreamingCopc({} as RangeSource, 'scan.copc.laz', new AbortController().signal, deps),
    ).rejects.toThrow(/GPU mesh build failed/);
    expect(calls.refreshCrs).not.toHaveBeenCalled();
    expect(calls.refreshProvenance).not.toHaveBeenCalled();
    expect(calls.hideEmptyState).not.toHaveBeenCalled();
  });

  it('an OPEN failure (before attach) never publishes candidate metadata', async () => {
    const { deps, calls } = makeCopcDeps({ openRejects: true, priorStreamingCloud: true });
    await expect(
      openStreamingCopc({} as RangeSource, 'scan.copc.laz', new AbortController().signal, deps),
    ).rejects.toThrow(/malformed COPC/i);
    expect(calls.refreshCrs).not.toHaveBeenCalled();
    expect(calls.refreshProvenance).not.toHaveBeenCalled();
  });
});
