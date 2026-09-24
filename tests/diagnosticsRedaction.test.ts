/**
 * diagnosticsRedaction.test.ts
 *
 * The error ledger and the Copy diagnostics report must never carry a file
 * path, a URL or a coordinate, whatever text reaches them, and the ledger stays
 * bounded.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ERROR_LEDGER_CAP, clearErrorLedger, errorCode, errorLedgerSnapshot, recordError,
} from '../src/app/diagnostics/errorLedger';
import { captureWindowErrors } from '../src/app/staleChunkReload';
import {
  DIAGNOSTICS_COPIED, DIAGNOSTICS_COPY_FAILED, buildDiagnosticsReport, copyDiagnostics,
  type DiagnosticsEnvironment, type DiagnosticsViewer,
} from '../src/app/diagnostics/copyDiagnostics';
import type { BuildIdentity } from '../src/build/buildIdentity';

const PATH = '/Users/x/file.laz';
const URL_ = 'https://h/t?token=abc';
const COORD = '512345.67, 4123456.89';
const LEAKS = [PATH, URL_, COORD, 'Users', 'file.laz', 'token', 'abc', '512345', '4123456'];

const env: DiagnosticsEnvironment = {
  userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ${PATH}`,
  isMobile: false,
  deviceMemoryGB: 8,
  hardwareConcurrency: 8,
  devicePixelRatio: 2,
};

const build: BuildIdentity = {
  version: '0.7.0', commit: 'd41e9f0', dirty: false, builtAt: '2026-09-24T00:00:00.000Z', node: 'v22', channel: 'live',
};

function viewer(format: string): DiagnosticsViewer {
  return {
    activeBackend: () => 'webgl2',
    streamingCloud: {
      kind: 'copc',
      residentPointCount: 1000,
      octree: { nodes: () => [{ state: 'resident' }, { state: 'resident' }, { state: 'idle' }] },
    },
    residentPointTotal: () => 1000,
    clouds: () => ['a', 'b'],
    getCloud: (id) => ({ sourceFormat: id === 'a' ? 'las' : format }),
  };
}

function assertClean(json: string): void {
  for (const leak of LEAKS) expect(json).not.toContain(leak);
}

beforeEach(() => clearErrorLedger());

describe('error ledger', () => {
  it('keeps only plain tokens, never text carrying a path, URL or coordinate', () => {
    recordError(PATH, URL_, true, COORD);
    recordError('gpu', `failed at ${COORD}`, false, `open ${URL_}`);
    const e = new Error(`could not read ${PATH} from ${URL_} at ${COORD}`);
    recordError('io', errorCode(e), true);
    const json = JSON.stringify(errorLedgerSnapshot());
    assertClean(json);
    expect(errorLedgerSnapshot()[0]).toMatchObject({ subsystem: 'other', code: 'other', action: 'other' });
    expect(errorLedgerSnapshot()[2]).toMatchObject({ subsystem: 'io', code: 'Error' });
  });

  it('is bounded to the cap and keeps the newest entries', () => {
    for (let i = 0; i < ERROR_LEDGER_CAP + 20; i++) recordError('s', `c${i}`, true, 'none', i);
    const snap = errorLedgerSnapshot();
    expect(snap).toHaveLength(ERROR_LEDGER_CAP);
    expect(snap[snap.length - 1].code).toBe(`c${ERROR_LEDGER_CAP + 19}`);
  });

  it('records window errors and unhandled rejections by class name only', () => {
    const target = new EventTarget();
    captureWindowErrors(target as unknown as Window);
    const err = Object.assign(new Event('error'), { error: new TypeError(`bad ${PATH}`) });
    target.dispatchEvent(err);
    const rej = Object.assign(new Event('unhandledrejection'), { reason: new Error(URL_) });
    target.dispatchEvent(rej);
    const snap = errorLedgerSnapshot();
    expect(snap.map((s) => [s.subsystem, s.code])).toEqual([['window', 'TypeError'], ['promise', 'Error']]);
    assertClean(JSON.stringify(snap));
  });
});

describe('diagnostics report', () => {
  it('holds the facts it promises and none of the leaks, even when fed them', () => {
    recordError('window', PATH, true);
    recordError('gpu', 'webgl-context-lost', true, 'wait-for-restore');
    const ledger = [...errorLedgerSnapshot(), { t: 1, subsystem: URL_, code: COORD, recoverable: true, action: PATH }];
    const report = buildDiagnosticsReport(viewer(PATH), env, ledger, { ...build, channel: URL_ });
    const json = JSON.stringify(report);
    assertClean(json);
    expect(report.browser).toEqual({ brand: 'Chrome', majorVersion: 131 });
    expect(report.platform).toEqual({ class: 'desktop', os: 'macOS' });
    expect(report.render).toEqual({ backend: 'webgl2', deviceTier: 'high', devicePixelRatio: 2 });
    expect(report.source).toEqual({ formats: ['las', 'other'], streaming: 'copc' });
    expect(report.resident).toEqual({ nodes: 2, points: 1000 });
    expect(report.build).toMatchObject({ version: '0.7.0', commit: 'd41e9f0', channel: 'other' });
    expect(report.errors.map((e) => e.code)).toEqual(['other', 'webgl-context-lost', 'other']);
  });

  it('reports null viewer facts before a scan opens', () => {
    const report = buildDiagnosticsReport(null, env, [], build);
    expect(report.render.backend).toBeNull();
    expect(report.resident).toEqual({ nodes: null, points: null });
    expect(report.source).toEqual({ formats: [], streaming: null });
  });
});

describe('copyDiagnostics', () => {
  it('writes clean JSON and confirms, or says the copy failed', async () => {
    const g = globalThis as { navigator?: unknown; window?: unknown };
    const hadWindow = 'window' in g;
    if (!hadWindow) g.window = { devicePixelRatio: 1 };
    try {
      recordError('io', PATH, true);
      let written = '';
      const notes: string[] = [];
      await copyDiagnostics(() => viewer(URL_), (m) => notes.push(m), async (t) => { written = t; });
      assertClean(written);
      expect(JSON.parse(written).schema).toBe('olv-diagnostics/1');
      await copyDiagnostics(() => null, (m) => notes.push(m), async () => { throw new Error('denied'); });
      expect(notes).toEqual([DIAGNOSTICS_COPIED, DIAGNOSTICS_COPY_FAILED]);
    } finally {
      if (!hadWindow) delete g.window;
    }
  });
});

describe('shared buffer', () => {
  it('the shell capture writes the key errorLedger reads', async () => {
    const { ERROR_LEDGER_KEY } = await import('../src/app/diagnostics/errorLedger');
    const src = (await import('node:fs')).readFileSync('src/app/staleChunkReload.ts', 'utf8');
    expect(src).toContain(`${ERROR_LEDGER_KEY} ??=`);
    expect(src).not.toMatch(/from\s+['"][^'"]*diagnostics/);
  });
});
