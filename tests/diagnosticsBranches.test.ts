/**
 * diagnosticsBranches.test.ts
 *
 * The optional and failing inputs of the diagnostics report, the error ledger,
 * the shell error capture and the Help action "Copy diagnostics": missing
 * viewer facts, unknown browsers, rejected clipboards and lazy-load failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A plain function rather than vi.fn: the spy's own result tracking would
// report a rejected load as unhandled even though the action catches it.
let loadImpl: () => Promise<unknown> = () => Promise.resolve({});
let loadCalls = 0;
vi.mock('../src/lazyChunks', () => ({ loadCopyDiagnostics: () => { loadCalls++; return loadImpl(); } }));

import {
  ERROR_LEDGER_CAP, ERROR_LEDGER_KEY, clearErrorLedger, errorCode, errorLedgerSnapshot, ledgerToken, recordError,
} from '../src/app/diagnostics/errorLedger';
import { captureWindowErrors } from '../src/app/staleChunkReload';
import {
  DIAGNOSTICS_COPIED, DIAGNOSTICS_COPY_FAILED, browserEnvironment, buildDiagnosticsReport, copyDiagnostics,
  type DiagnosticsEnvironment, type DiagnosticsViewer,
} from '../src/app/diagnostics/copyDiagnostics';
import { contributeHelpActions } from '../src/app/actions/helpActions';
import type { BuildIdentity } from '../src/build/buildIdentity';

const build: BuildIdentity = {
  version: '0.7.0', commit: 'd41e9f0', dirty: false, builtAt: '2026-09-24T00:00:00.000Z', node: 'v22', channel: 'live',
};
const env = (over: Partial<DiagnosticsEnvironment> = {}): DiagnosticsEnvironment => ({
  userAgent: '', isMobile: false, devicePixelRatio: 1, ...over,
});
const boom = (): never => { throw new Error('gone'); };

beforeEach(() => clearErrorLedger());
afterEach(() => vi.unstubAllGlobals());

describe('diagnostics report: browser and platform', () => {
  it('prefers a named client-hint brand over Chromium and the placeholder brand', () => {
    const brands = [{ brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '131' }, { brand: 'Google Chrome', version: '131' }];
    expect(buildDiagnosticsReport(null, env({ brands }), [], build).browser).toEqual({ brand: 'Google-Chrome', majorVersion: 131 });
  });

  it('falls back to Chromium, and to a null version when it is not a number', () => {
    const brands = [{ brand: 'Not.A/Brand', version: '99' }, { brand: 'Chromium', version: 'x' }];
    expect(buildDiagnosticsReport(null, env({ brands }), [], build).browser).toEqual({ brand: 'Chromium', majorVersion: null });
  });

  it.each([
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36 Edg/120.0', 'Edge', 120, 'Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Firefox', 128, 'Linux'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1', 'Safari', 17, 'iOS'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/125.0 Mobile Safari/537.36', 'Chrome', 125, 'Android'],
    ['Mozilla/5.0 (X11; CrOS x86_64) Chromium/118.0', 'Chrome', 118, 'ChromeOS'],
    ['curl/8', 'other', null, 'other'],
  ])('reads %s from the user agent', (ua, brand, major, os) => {
    const report = buildDiagnosticsReport(null, env({ userAgent: ua, brands: [] }), [], build);
    expect(report.browser).toEqual({ brand, majorVersion: major });
    expect(report.platform.os).toBe(os);
  });

  it('classes a mobile device and rounds the pixel ratio', () => {
    const report = buildDiagnosticsReport(null, env({ isMobile: true, devicePixelRatio: 2.6251 }), [], build);
    expect(report.platform.class).toBe('mobile');
    expect(report.render.devicePixelRatio).toBe(2.63);
  });
});

describe('diagnostics report: missing and failing inputs', () => {
  it('replaces build fields that are not in their expected form', () => {
    const odd = { ...build, version: 'dev build', commit: '/x/y', builtAt: 'yesterday', dirty: true };
    expect(buildDiagnosticsReport(null, env(), [], odd).build).toEqual({
      version: 'other', commit: 'other', dirty: true, channel: 'live', builtAt: 'other',
    });
  });

  it('survives a viewer whose every accessor throws', () => {
    const v = {
      activeBackend: boom, residentPointTotal: boom, clouds: boom, getCloud: boom,
      get streamingCloud(): never { return boom(); },
    } as unknown as DiagnosticsViewer;
    const report = buildDiagnosticsReport(v, env(), [], build);
    expect(report.render.backend).toBe('other');
    expect(report.source).toEqual({ formats: [], streaming: null });
    expect(report.resident).toEqual({ nodes: null, points: null });
  });

  it('reports no streaming session, an unknown source format and a throwing octree', () => {
    const plain: DiagnosticsViewer = {
      activeBackend: () => 'webgpu', streamingCloud: null, residentPointTotal: () => 12.6,
      clouds: () => ['a', 'b'], getCloud: (id) => (id === 'a' ? undefined : { sourceFormat: null }),
    };
    const r1 = buildDiagnosticsReport(plain, env(), [], build);
    expect(r1.source).toEqual({ formats: ['unknown'], streaming: null });
    expect(r1.resident).toEqual({ nodes: null, points: 13 });
    const broken = { ...plain, streamingCloud: { kind: 'ept', residentPointCount: 0, octree: { nodes: boom } } };
    expect(buildDiagnosticsReport(broken, env(), [], build).resident.nodes).toBeNull();
  });

  it('reads the live ledger by default and coerces a non-true recoverable flag', () => {
    recordError('io', 'AbortError', 1 as unknown as boolean, 'retry', 4.4);
    const report = buildDiagnosticsReport(null, env());
    expect(report.errors).toEqual([{ t: 4, subsystem: 'io', code: 'AbortError', recoverable: false, action: 'retry' }]);
  });
});

describe('browserEnvironment', () => {
  it('reads client hints, memory and cores, and defaults a zero pixel ratio to 1', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'UA', userAgentData: { brands: [{ brand: 'Edge', version: '1' }] }, deviceMemory: 4, hardwareConcurrency: 2,
    });
    vi.stubGlobal('window', { devicePixelRatio: 0, innerWidth: 1280, matchMedia: () => ({ matches: false }) });
    const e = browserEnvironment();
    expect(e).toMatchObject({ userAgent: 'UA', brands: [{ brand: 'Edge', version: '1' }], deviceMemoryGB: 4, hardwareConcurrency: 2, devicePixelRatio: 1 });
  });

  it('leaves hints undefined when the browser has none', () => {
    vi.stubGlobal('navigator', { userAgent: 'UA' });
    vi.stubGlobal('window', { devicePixelRatio: 3, innerWidth: 1280, matchMedia: () => ({ matches: false }) });
    const e = browserEnvironment();
    expect(e.brands).toBeUndefined();
    expect(e.deviceMemoryGB).toBeUndefined();
    expect(e.devicePixelRatio).toBe(3);
  });
});

describe('copyDiagnostics', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1280, matchMedia: () => ({ matches: false }) });
  });

  it('uses the clipboard API by default', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { userAgent: 'UA', clipboard: { writeText } });
    const notes: string[] = [];
    await copyDiagnostics(() => undefined, (m) => notes.push(m));
    expect(notes).toEqual([DIAGNOSTICS_COPIED]);
    const report = JSON.parse(String((writeText.mock.calls as unknown as string[][])[0][0]));
    expect(Object.keys(report)).toEqual(['schema', 'build', 'browser', 'platform', 'render', 'source', 'resident', 'errors', 'runtime']);
    expect(report.render.backend).toBeNull();
  });

  it('reports failure when the clipboard API is absent or the viewer getter throws', async () => {
    vi.stubGlobal('navigator', { userAgent: 'UA' });
    const notes: string[] = [];
    await copyDiagnostics(boom, (m) => notes.push(m));
    expect(notes).toEqual([DIAGNOSTICS_COPY_FAILED]);
  });
});

describe('error ledger', () => {
  it('reduces non-token values to other, and error codes to their class or type', () => {
    expect(ledgerToken(42)).toBe('other');
    expect(ledgerToken('9lives')).toBe('other');
    expect(errorCode(new RangeError('x'))).toBe('RangeError');
    expect(errorCode({ message: 'x' })).toBe('object');
    expect(errorCode(null)).toBe('object');
    expect(errorCode('text')).toBe('string');
    expect(errorCode(undefined)).toBe('undefined');
  });

  it('wraps at capacity one entry at a time and uses performance time by default', () => {
    for (let i = 0; i < ERROR_LEDGER_CAP; i++) recordError('s', `c${i}`, true, 'none', i);
    recordError('s', 'newest', true);
    const snap = errorLedgerSnapshot();
    expect(snap).toHaveLength(ERROR_LEDGER_CAP);
    expect(snap[0].code).toBe('c1');
    expect(snap.at(-1)).toMatchObject({ code: 'newest', action: 'none' });
    expect(Number.isFinite(snap.at(-1)!.t)).toBe(true);
  });

  it('turns captured tuples into entries and repairs malformed stored entries', () => {
    const raw = (globalThis as Record<string, unknown>)[ERROR_LEDGER_KEY] as unknown[];
    raw.push([5, 0, 'TypeError'], [6, 1, 0], { t: 'x', subsystem: 1, code: 'ok', recoverable: 'yes', action: null });
    expect(errorLedgerSnapshot()).toEqual([
      { t: 5, subsystem: 'window', code: 'TypeError', recoverable: true, action: 'reload-if-stuck' },
      { t: 6, subsystem: 'promise', code: 'non-error', recoverable: true, action: 'none' },
      { t: 0, subsystem: 'other', code: 'ok', recoverable: false, action: 'other' },
    ]);
  });
});

describe('captureWindowErrors', () => {
  it('records errors without an Error object and non-Error rejections as class 0, bounded to 50', () => {
    const target = new EventTarget();
    captureWindowErrors(target as unknown as Window);
    target.dispatchEvent(new Event('error'));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'plain string' }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: { code: 1 } }));
    expect(errorLedgerSnapshot().map((e) => [e.subsystem, e.code])).toEqual([
      ['window', 'non-error'], ['promise', 'non-error'], ['promise', 'non-error'],
    ]);
    for (let i = 0; i < 60; i++) target.dispatchEvent(Object.assign(new Event('error'), { error: new SyntaxError('x') }));
    const raw = (globalThis as Record<string, unknown>)[ERROR_LEDGER_KEY] as unknown[];
    expect(raw).toHaveLength(50);
    expect(errorLedgerSnapshot().every((e) => e.code === 'SyntaxError')).toBe(true);
  });

  it('creates the shared buffer when none exists yet', () => {
    delete (globalThis as Record<string, unknown>)[ERROR_LEDGER_KEY];
    const target = new EventTarget();
    captureWindowErrors(target as unknown as Window);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new TypeError('x') }));
    expect((globalThis as Record<string, unknown>)[ERROR_LEDGER_KEY]).toHaveLength(1);
  });
});

describe('startup capture', () => {
  it('installs on the window when the shell module loads in a browser', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    vi.resetModules();
    await import('../src/app/staleChunkReload');
    target.dispatchEvent(Object.assign(new Event('error'), { error: new EvalError('x') }));
    expect(errorLedgerSnapshot().map((e) => e.code)).toEqual(['EvalError']);
  });
});

describe('Help: Copy diagnostics action', () => {
  const baseDeps = {
    getTour: () => null,
    ensureShortcutSheet: () => Promise.resolve({ open: () => {} } as never),
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const find = (actions: ReturnType<typeof contributeHelpActions>) => {
    const a = actions.find((x) => x.id === 'help.copy-diagnostics');
    if (!a) throw new Error('missing');
    return a;
  };

  beforeEach(() => { loadCalls = 0; });

  it('is registered under Help with a hint', () => {
    const a = find(contributeHelpActions(baseDeps));
    expect(a).toMatchObject({ title: 'Copy diagnostics', section: 'Help' });
    expect(a.hint).toMatch(/No file names, links or coordinates/);
    expect(a.keywords).toContain('diagnostics');
  });

  it('loads the lazy chunk and calls through with the viewer getter and notifier', async () => {
    const copy = vi.fn(async () => {});
    loadImpl = () => Promise.resolve({ copyDiagnostics: copy });
    const getViewer = () => null;
    const notify = vi.fn();
    find(contributeHelpActions({ ...baseDeps, getViewer, notify })).run();
    await flush();
    expect(loadCalls).toBe(1);
    expect(copy).toHaveBeenCalledWith(getViewer, notify);
  });

  it('defaults the viewer getter to null and the notifier to a no-op', async () => {
    const copy = vi.fn(async (get: () => unknown, note: (m: string) => void) => { note('x'); expect(get()).toBeNull(); });
    loadImpl = () => Promise.resolve({ copyDiagnostics: copy });
    find(contributeHelpActions(baseDeps)).run();
    await flush();
    expect(copy).toHaveBeenCalledTimes(1);
    loadImpl = () => Promise.reject(new Error('chunk'));
    find(contributeHelpActions(baseDeps)).run();
    await flush();
  });

  it('says the report could not load when the chunk fails', async () => {
    loadImpl = () => Promise.reject(new Error('chunk'));
    const notify = vi.fn();
    find(contributeHelpActions({ ...baseDeps, notify })).run();
    await flush();
    expect(notify).toHaveBeenCalledWith('Could not load the diagnostics report. Nothing was changed. Reload the page and try again.');
  });

  it('swallows a shortcut-sheet load failure', async () => {
    const actions = contributeHelpActions({ ...baseDeps, ensureShortcutSheet: () => Promise.reject(new Error('x')) });
    actions.find((a) => a.id !== 'help.copy-diagnostics' && /shortcut/i.test(a.title))!.run();
    await flush();
  });
});
