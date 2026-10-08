/**
 * Shared harness for the UX journey specs (tests/e2e/journeys).
 *
 * Every journey step records a screenshot and the console errors, page errors
 * and failed requests seen while it ran, and fails on any error that is not on
 * the allowlist below. Exports are read back from the downloaded bytes, never
 * counted.
 *
 * Set OLV_JOURNEY_EVIDENCE to a directory to also copy each step's screenshot
 * there as `<journey>/<project>/<step>.png`. Without it the screenshots are
 * attached to the test result only.
 */
import { expect, test, type Download, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isBenignPageError } from '../../pageErrors';

/**
 * Console and page errors a journey step may see without failing. Each entry
 * names the reason it is not an application fault.
 */
export const ERROR_ALLOWLIST: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /ResizeObserver loop (completed with undelivered notifications|limit exceeded)/i,
    reason: 'Browser notification when a ResizeObserver callback causes layout; not an app fault (see pageErrors.ts).',
  },
  {
    pattern: /^Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive/,
    reason:
      "WebKit only: Playwright's screenshot injects an inline <style>, which the app's CSP blocks. " +
      'App-raised CSP violations are still caught: startJourney records securitypolicyviolation events and fails on any that is not an inline style shortly after a screenshot.',
  },
  {
    pattern: /GL Driver Message|GPU stall due to ReadPixels/,
    reason: 'Chromium driver performance note emitted when a spec reads pixels back; not raised by the app.',
  },
];

/** Allowlist entries a single journey adds for a step that causes them on purpose. */
export type AllowEntry = { pattern: RegExp; reason: string };

/** True when an error message is allowlisted. */
export function isAllowedError(message: string, extra: ReadonlyArray<AllowEntry> = []): boolean {
  return isBenignPageError(message) || [...ERROR_ALLOWLIST, ...extra].some((e) => e.pattern.test(message));
}

/** The evidence one journey collects across its steps. */
export interface Journey {
  /** Run one named step, then screenshot and check for unexpected errors. */
  step<T>(name: string, body: () => Promise<T>): Promise<T>;
  /** Save a screenshot under a name without the error check. */
  capture(name: string): Promise<string>;
  /** Every error seen so far that was not allowlisted. */
  readonly unexpected: string[];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** Start collecting console errors, page errors and failed requests for `page`. */
export function startJourney(page: Page, info: TestInfo, journeyId: string, extraAllow: ReadonlyArray<AllowEntry> = []): Journey {
  const unexpected: string[] = [];
  const failedRequests: string[] = [];
  let since = 0;
  page.on('console', (m) => {
    if (m.type() === 'error' && !isAllowedError(m.text(), extraAllow)) unexpected.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    if (!isAllowedError(e.message, extraAllow)) unexpected.push(`pageerror: ${e.message}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    // A download or an aborted prefetch reports as failed in some engines.
    if (/aborted|cancel/i.test(why) || r.url().startsWith('blob:') || r.url().startsWith('data:')) return;
    failedRequests.push(`${r.method()} ${r.url()} ${why}`);
  });
  const dir = process.env.OLV_JOURNEY_EVIDENCE
    ? join(process.env.OLV_JOURNEY_EVIDENCE, journeyId, info.project.name)
    : null;
  if (dir) mkdirSync(dir, { recursive: true });
  // CSP violations the app causes, recorded in the page with their time. WebKit
  // blocks the inline <style> Playwright injects for a screenshot, and on a busy
  // runner that violation event arrives well after the screenshot returns, so
  // an inline style-src-elem violation within SHOT_GRACE_MS of a screenshot is
  // the harness's own and is dropped; every other violation fails the step.
  void page.addInitScript(() => {
    const w = window as unknown as { __jCsp: Array<{ t: number; text: string; inlineStyle: boolean }>; __jShots: number[] };
    w.__jCsp = [];
    w.__jShots = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__jCsp.push({
        t: performance.now(),
        text: `${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`,
        inlineStyle: e.violatedDirective.startsWith('style-src') && e.blockedURI === 'inline',
      });
    });
  });
  const SHOT_GRACE_MS = 5_000;
  const cspViolations = (): Promise<string[]> =>
    page
      .evaluate((grace) => {
        const w = window as unknown as { __jCsp?: Array<{ t: number; text: string; inlineStyle: boolean }>; __jShots?: number[] };
        const shots = w.__jShots ?? [];
        return (w.__jCsp?.splice(0) ?? [])
          .filter((v) => !(v.inlineStyle && shots.some((s) => v.t >= s && v.t - s <= grace)))
          .map((v) => v.text);
      }, SHOT_GRACE_MS)
      .catch(() => []);
  let n = 0;

  const capture = async (name: string): Promise<string> => {
    n += 1;
    const file = `${String(n).padStart(2, '0')}-${slug(name)}.png`;
    await page.evaluate(() => { (window as unknown as { __jShots?: number[] }).__jShots?.push(performance.now()); }).catch(() => undefined);
    const shot = await page.screenshot({ fullPage: false }).catch(() => null);
    if (!shot) return '';
    await info.attach(file, { body: shot, contentType: 'image/png' });
    if (dir) {
      writeFileSync(join(dir, file), shot);
      return join(dir, file);
    }
    return file;
  };

  return {
    unexpected,
    capture,
    async step<T>(name: string, body: () => Promise<T>): Promise<T> {
      return test.step(name, async () => {
        let result: T;
        try {
          result = await body();
        } finally {
          for (const v of await cspViolations()) unexpected.push(`csp: ${v}`);
          await capture(name);
        }
        const fresh = unexpected.slice(since);
        since = unexpected.length;
        if (failedRequests.length) {
          await info.attach(`${slug(name)}-failed-requests.txt`, { body: failedRequests.splice(0).join('\n'), contentType: 'text/plain' });
        }
        expect(fresh, `unexpected console or page errors during "${name}"`).toEqual([]);
        return result;
      });
    },
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Bytes of a file under tests/fixtures. */
export function fixtureBytes(rel: string): Uint8Array {
  return new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../fixtures/${rel}`, import.meta.url))));
}

/** Drop bytes as a named file on the page, the path a dragged file takes. */
export async function dropBytes(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ b, n }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(b)], n));
      return dt;
    },
    { b: [...bytes], n: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/** Open the app on the test seam and drop one file, waiting for the scene. */
export async function openWith(page: Page, bytes: Uint8Array, name: string): Promise<number> {
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty')).toBeVisible();
  const t0 = Date.now();
  await dropBytes(page, bytes, name);
  // A 120 000-point LAZ takes about 30 s to open on a CI software renderer.
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 60_000 });
  await page.waitForFunction(() => 'getCameraPose' in ((window as unknown as { __OLV_TEST_API__?: object }).__OLV_TEST_API__ ?? {}), undefined, { timeout: 20_000 });
  return Date.now() - t0;
}

/**
 * `src/convert/writeLas` reads the Vite-defined `__BUILD_IDENTITY__` at module
 * load, so the global is stubbed before the import (the exportPanel spec does
 * the same).
 */
export async function loadLasWriter(): Promise<typeof import('../../../../src/convert/writeLas')> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test',
    commit: 'unknown',
    dirty: false,
    builtAt: '1970-01-01T00:00:00.000Z',
  };
  return import('../../../../src/convert/writeLas');
}

/** The class mix of the P2 survey fixture, with its expected counts. */
export interface SurveyFixture {
  bytes: Uint8Array;
  count: number;
  classCounts: Record<number, number>;
  overlapCount: number;
  epsg: number;
}

/**
 * The P2 LAS 1.4 survey file: a 30 x 30 grid on WGS 84 / UTM 13N, mostly
 * ground (2), with low noise (7), rail (10), high noise (18) and overlap flags.
 * Built with the app's own LAS 1.4 writer, so no binary is committed.
 */
export async function buildSurveyLas14(): Promise<SurveyFixture> {
  const { writeLas14 } = await loadLasWriter();
  const N = 30;
  const count = N * N;
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const z = new Float64Array(count);
  const classification = new Uint8Array(count);
  const classificationFlags = new Uint8Array(count);
  const intensity = new Uint16Array(count);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const k = i * N + j;
      x[k] = 500000 + i;
      y[k] = 4100000 + j;
      z[k] = 1500 + 0.1 * i + 0.05 * j;
      classification[k] = 2;
      intensity[k] = 100 + k;
      if (k % 37 === 0) { classification[k] = 7; z[k] -= 8; }
      else if (k % 41 === 0) { classification[k] = 18; z[k] += 30; }
      else if (k % 53 === 0) classification[k] = 10;
      if (i >= 25) classificationFlags[k] = 8;
    }
  }
  const classCounts: Record<number, number> = {};
  for (const c of classification) classCounts[c] = (classCounts[c] ?? 0) + 1;
  const overlapCount = classificationFlags.filter((f) => f & 8).length;
  const bytes = writeLas14(
    { count, x, y, z, classification, classificationFlags, intensity },
    { epsg: 32613, linearUnitCode: 9001 },
  );
  return { bytes, count, classCounts, overlapCount, epsg: 32613 };
}

/** Two overlapping UTM 13N tiles, each 20 m wide, sharing a 10 m strip. */
export async function buildOverlappingTiles(): Promise<Array<{ name: string; bytes: Uint8Array; count: number }>> {
  const { writeLas14 } = await loadLasWriter();
  const tile = (x0: number) => {
    const N = 20;
    const count = N * N;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    const z = new Float64Array(count);
    const classification = new Uint8Array(count).fill(2);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const k = i * N + j;
      x[k] = 500000 + x0 + i;
      y[k] = 4100000 + j;
      z[k] = 1500 + 0.1 * (x0 + i);
    }
    return { count, bytes: writeLas14({ count, x, y, z, classification }, { epsg: 32613, linearUnitCode: 9001 }) };
  };
  return [
    { name: 'tile-a.las', ...tile(0) },
    { name: 'tile-b.las', ...tile(10) },
  ];
}

// ── reading the scene ───────────────────────────────────────────────────────

export interface Pose { position: number[]; target: number[] }

export async function cameraPose(page: Page): Promise<Pose> {
  return page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: { getCameraPose?: () => Pose } }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    if (!p) throw new Error('no camera pose: open the page with ?test=1');
    return { position: [...p.position], target: [...p.target] };
  });
}

export interface ProbeHit { index: number; x: number; y: number; z: number }

/**
 * The scan point the viewer's own hover probe finds under a canvas pixel, or
 * null. The probe event is the one the coordinate readout listens to.
 */
export async function probePointUnder(page: Page, px: number, py: number): Promise<ProbeHit | null> {
  const box = (await page.locator('.olv-canvas').boundingBox())!;
  await page.evaluate(() => {
    const w = window as unknown as { __jProbe?: ProbeHit | null; __jProbeOn?: boolean };
    w.__jProbe = null;
    if (!w.__jProbeOn) {
      w.__jProbeOn = true;
      window.addEventListener('olv:probe-hover', (e) => {
        const d = (e as CustomEvent<ProbeHit | null>).detail;
        w.__jProbe = d ? { index: d.index, x: d.x, y: d.y, z: d.z } : null;
      });
    }
  });
  await page.mouse.move(box.x + px + 3, box.y + py + 3);
  await page.mouse.move(box.x + px, box.y + py);
  for (let i = 0; i < 16; i++) {
    const h = await page.evaluate(() => (window as unknown as { __jProbe?: ProbeHit | null }).__jProbe ?? null);
    if (h) return h;
    await page.waitForTimeout(50);
  }
  return null;
}

/** Page positions of every point of layer 0 that projects, through the test seam. */
export async function projectAllPoints(page: Page, count: number): Promise<Array<{ x: number; y: number }>> {
  return page.evaluate((n) => {
    const api = (window as unknown as { __OLV_TEST_API__: {
      layerProjectPoints: (i: number) => Array<{ project: [number, number, number] }>;
      projectToClient: (p: { x: number; y: number; z: number }) => { x: number; y: number } | null;
    } }).__OLV_TEST_API__;
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < n; i++) {
      const p = api.layerProjectPoints(i)[0]?.project;
      const xy = p ? api.projectToClient({ x: p[0], y: p[1], z: p[2] }) : null;
      if (xy) out.push(xy);
    }
    return out;
  }, count);
}

// ── exports ────────────────────────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface ParsedLasExport {
  versionMajor: number;
  versionMinor: number;
  pointFormat: number;
  count: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  generatingSoftware: string;
  /** Every VLR as user id / record id / description / payload text. */
  vlrs: Array<{ userId: string; recordId: number; description: string; text: string }>;
  /** The LASF_Spec record 3 text, where the provenance lines live. */
  provenance: string;
  /** Legacy (5-bit) or full classification byte per point. */
  classes: number[];
}

function ascii(b: Uint8Array, from: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = b[from + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Parse a downloaded LAS (1.2 or 1.4) independently of the app's reader. */
export function parseLasExport(bytes: Uint8Array): ParsedLasExport {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(ascii(bytes, 0, 4), 'LAS signature').toBe('LASF');
  const versionMajor = v.getUint8(24);
  const versionMinor = v.getUint8(25);
  const headerSize = v.getUint16(94, true);
  const dataOffset = v.getUint32(96, true);
  const nVlr = v.getUint32(100, true);
  const pointFormat = v.getUint8(104) & 0x3f;
  const recLen = v.getUint16(105, true);
  const count = versionMinor >= 4 ? Number(v.getBigUint64(247, true)) : v.getUint32(107, true);
  const t = (base: number, stride: number) => [0, 1, 2].map((a) => v.getFloat64(base + a * stride, true)) as [number, number, number];
  const vlrs: ParsedLasExport['vlrs'] = [];
  let p = headerSize;
  for (let k = 0; k < nVlr; k++) {
    const userId = ascii(bytes, p + 2, 16);
    const recordId = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    const description = ascii(bytes, p + 22, 32);
    const text = ascii(bytes, p + 54, len);
    vlrs.push({ userId, recordId, description, text });
    p += 54 + len;
  }
  const classOffset = pointFormat >= 6 ? 16 : 15;
  const classes: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = v.getUint8(dataOffset + i * recLen + classOffset);
    classes.push(pointFormat >= 6 ? b : b & 0x1f);
  }
  return {
    versionMajor,
    versionMinor,
    pointFormat,
    count,
    scale: t(131, 8),
    offset: t(155, 8),
    max: [v.getFloat64(179, true), v.getFloat64(195, true), v.getFloat64(211, true)],
    min: [v.getFloat64(187, true), v.getFloat64(203, true), v.getFloat64(219, true)],
    generatingSoftware: ascii(bytes, 26, 32),
    vlrs,
    provenance: vlrs.find((r) => r.userId === 'LASF_Spec' && r.recordId === 3)?.text ?? '',
    classes,
  };
}

export interface ParsedXyz {
  comments: string[];
  rows: number[][];
}

/** Split an XYZ/ASC export into its `#` header lines and numeric rows. */
export function parseXyzExport(text: string): ParsedXyz {
  const comments: string[] = [];
  const rows: number[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) comments.push(line);
    else if (line.trim()) rows.push(line.trim().split(/[\s,]+/).map(Number));
  }
  return { comments, rows };
}

/** The bytes of a finished download, with its suggested name. */
export async function downloadBytes(download: Download): Promise<{ name: string; bytes: Uint8Array }> {
  const path = await download.path();
  if (!path) throw new Error('download produced no local path');
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)) };
}

/** A download file name a user can save on any platform. */
export const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
