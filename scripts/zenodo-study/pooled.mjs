/**
 * pooled.mjs: the pooled LAZ decode of the Zenodo small-file study, in a real
 * browser with real workers.
 *
 * Starts the Vite dev server, opens a blank page on its origin in Chromium
 * (Playwright), and in that page imports the production loader and calls
 * `loadLazFromFile` on the hash-checked file with the default decode policy.
 * For a file of at least a million points that policy fans the LAZ chunks
 * across a pool of `lazChunkWorker` workers. The run fails unless the loader
 * reports `decodePath: 'pooled'` with at least one pool worker; a fallback to
 * the serial decode is a failure, never a pass.
 *
 * Difference from the app: the app calls the loader from its parse worker,
 * this page calls it from the page. The chunk pool, the per-chunk decode, the
 * origin choice and the cloud construction are the same modules.
 *
 * The page builds canonical records (canonical.mjs) from `cloudToGlobal` and
 * posts them back; nothing is compared here.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const STUDY = '/__zenodo_study';

export function startVite(repo) {
  return new Promise((resolveStart, reject) => {
    const bin = join(repo, 'node_modules', '.bin', 'vite');
    const child = spawn(bin, ['--port', '0', '--strictPort', '--clearScreen', 'false'], {
      cwd: repo,
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const timer = setTimeout(() => reject(new Error(`vite did not start:\n${log}`)), 60_000);
    const onData = (d) => {
      log += d.toString();
      // eslint-disable-next-line no-control-regex
      const m = /Local:\s+(http:\/\/localhost:\d+)\/?/.exec(log.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) {
        clearTimeout(timer);
        resolveStart({ child, url: m[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`vite exited (${code}):\n${log}`));
    });
  });
}

/**
 * @returns {Promise<object>} the page's summary; throws when the browser or
 *   Playwright is unavailable (the caller reports that as `unavailable`).
 */
export async function runPooled({ repo, input, outDir, headed = false }) {
  const require = createRequire(join(repo, 'package.json'));
  const { chromium } = require('@playwright/test');
  const bytes = readFileSync(input);
  const { child, url } = await startVite(repo);
  const browser = await chromium.launch({ headless: !headed });
  try {
    const page = await browser.newPage();
    const workers = [];
    const pageErrors = [];
    let workersClosed = 0;
    page.on('worker', (w) => {
      workers.push(w.url());
      w.on('close', () => { workersClosed++; });
    });
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // Records come back in parts: one 88 MB body is past what the browser
    // protocol carries in a single message.
    const parts = [];
    await page.route(`${url}${STUDY}/page`, (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>study</title><script type="module" src="/@vite/env"></script>' }));
    await page.route(`${url}${STUDY}/input.laz`, (r) => r.fulfill({ contentType: 'application/octet-stream', body: bytes }));
    await page.route(`${url}${STUDY}/records*`, async (r) => {
      const part = Number(new URL(r.request().url()).searchParams.get('part'));
      parts[part] = r.request().postDataBuffer();
      await r.fulfill({ status: 204 });
    });
    await page.goto(`${url}${STUDY}/page`);
    await page.waitForFunction(() => typeof globalThis.__OLV_DEV_FLAGS__ !== 'undefined', null, { timeout: 30_000 });
    const summary = await page.evaluate(async (base) => {
      const { loadLazFromFile } = await import('/src/io/loadLas.ts');
      const { cloudToGlobal } = await import('/src/convert/globalPoints.ts');
      const { sourcePositions } = await import('/src/model/pointFrames.ts');
      const { canonicalFromGlobal, integerBounds } = await import('/scripts/zenodo-study/canonical.mjs');
      const buf = await (await fetch(`${base}/input.laz`)).arrayBuffer();
      const file = new File([buf], 'iPhone.laz');
      let stats;
      let previewChunks = 0;
      const t0 = performance.now();
      const cloud = await loadLazFromFile(
        file, 'iPhone.laz', 1, undefined,
        () => { previewChunks++; },
        (s) => { stats = s; },
        undefined, undefined, true,
      );
      const ms = performance.now() - t0;
      const q = cloud.metadata.sourceQuantisation;
      const c = canonicalFromGlobal(cloudToGlobal(cloud), { scale: [...q.scale], offset: [...q.offset] }, { local: sourcePositions(cloud) });
      const PART = 4 << 20;
      let partCount = 0;
      for (let o = 0; o < c.records.byteLength; o += PART) {
        await fetch(`${base}/records?part=${partCount++}`, { method: 'POST', body: c.records.subarray(o, o + PART) });
      }
      return {
        path: 'pooled',
        partCount,
        canonical: { file: 'pooled.records.bin', count: c.count, fields: c.fields },
        representation: c.stats,
        integerBounds: integerBounds(c),
        decodePath: stats?.decodePath,
        poolWorkers: stats?.poolWorkers,
        poolFallbackReason: stats?.poolFallbackReason ?? null,
        lazChunkCount: stats?.lazChunkCount,
        rangeRequests: stats?.rangeRequests,
        compressedBytesRead: stats?.compressedBytesRead,
        previewChunks,
        declaredPointCount: cloud.declaredPointCount,
        decodedPointCount: cloud.decodedPointCount,
        pointCount: cloud.pointCount,
        origin: [...cloud.sourceOrigin],
        crs: cloud.metadata.crs ?? null,
        normals: cloud.normals ? 'present' : 'absent',
        decodeMs: Math.round(ms),
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
      };
    }, `${url}${STUDY}`);
    if (parts.length !== summary.partCount || parts.some((p) => !p)) throw new Error('the page posted an incomplete record set');
    writeFileSync(join(outDir, 'pooled.records.bin'), Buffer.concat(parts));
    const out = {
      ...summary,
      browser: `chromium ${browser.version()}`,
      headless: !headed,
      chunkWorkersSeen: workers.filter((w) => /lazChunkWorker/i.test(w)).length,
      workersSeen: workers.length,
      workersClosedAfterLoad: await page.waitForTimeout(2000).then(() => workersClosed),
      pageErrors,
    };
    writeFileSync(join(outDir, 'pooled.json'), JSON.stringify(out, null, 2));
    return out;
  } finally {
    await browser.close();
    child.kill('SIGTERM');
  }
}
