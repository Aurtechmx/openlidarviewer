/**
 * deploySmokeWiring.test.ts — the deploy smoke must actually reach the archive.
 *
 * The check it performs is worth nothing if the run can be satisfied by
 * something other than the extracted bytes, or if the release can be cut
 * without running it. Three ways that could happen, each covered here:
 *
 *   REUSE. Playwright reuses an already-running server outside CI. A server
 *   left on the port from an earlier `npm run dev` would answer every request,
 *   the specs would pass, and the archive would never be opened.
 *
 *   AN OCCUPIED PORT. If the static server treats a port it cannot bind as
 *   survivable, the same thing happens by another route.
 *
 *   ORDER. Smoking a build and then packaging a second one is exactly the gap
 *   this whole mechanism exists to close, so the workflow step has to sit after
 *   packaging and before anything assembles or uploads the payload.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import {
  readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read the config's webServer settings under a given environment. */
function webServerUnder(env: Record<string, string>): Record<string, unknown> {
  // A child process, because the config reads process.env at module scope and
  // vitest cannot un-import it cleanly once evaluated.
  const out = execFileSync(
    process.execPath,
    ['--experimental-strip-types', '-e',
      `import('./playwright.config.ts').then((m) => {
         const w = m.default.webServer;
         console.log(JSON.stringify({ command: w.command, url: w.url, reuse: w.reuseExistingServer }));
       })`],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } },
  );
  return JSON.parse(out.trim().split('\n').pop()!);
}

describe('playwright deploy-root mode', () => {
  it('never reuses an existing server, even outside CI', () => {
    const w = webServerUnder({ OLV_DEPLOY_ROOT: '/tmp/whatever', CI: '' });
    expect(w.reuse).toBe(false);
  });

  it('still allows reuse for the ordinary local build loop', () => {
    const w = webServerUnder({ OLV_DEPLOY_ROOT: '', CI: '' });
    expect(w.reuse).toBe(true);
  });

  it('serves the archive rather than building, and passes the path out of band', () => {
    // The directory must NOT appear in the command: `command` is shell text, so
    // a path containing a space would split into two arguments.
    const w = webServerUnder({ OLV_DEPLOY_ROOT: '/tmp/a directory/with spaces' });
    expect(w.command).toBe('node scripts/serve-deploy-bytes.mjs');
    expect(String(w.command)).not.toContain('with spaces');
    expect(String(w.command)).not.toContain('build');
  });

  it('binds the url to the port it was handed', () => {
    const w = webServerUnder({ OLV_DEPLOY_ROOT: '/tmp/x', OLV_DEPLOY_PORT: '4321' });
    // Loopback by address, because the server binds 127.0.0.1 explicitly.
    expect(w.url).toBe('http://127.0.0.1:4321');
  });
});

describe('serve-deploy-bytes on an occupied port', () => {
  it('exits non-zero instead of letting another server answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-serve-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html>');
    // Occupy a port, then ask the server for the same one.
    const squatter = createServer();
    const port: number = await new Promise((res) => {
      squatter.listen(0, '127.0.0.1', () => res((squatter.address() as { port: number }).port));
    });
    try {
      const code: number = await new Promise((res) => {
        const p = spawn(process.execPath, ['scripts/serve-deploy-bytes.mjs'], {
          cwd: ROOT,
          env: { ...process.env, OLV_DEPLOY_ROOT: dir, OLV_DEPLOY_PORT: String(port) },
          stdio: 'ignore',
        });
        p.on('exit', (c) => res(c ?? -1));
      });
      // A zero here would mean the smoke could run green against whatever was
      // already listening.
      expect(code).not.toBe(0);
    } finally {
      squatter.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a root that does not exist', async () => {
    const code: number = await new Promise((res) => {
      const p = spawn(process.execPath, ['scripts/serve-deploy-bytes.mjs'], {
        cwd: ROOT,
        env: { ...process.env, OLV_DEPLOY_ROOT: join(tmpdir(), 'olv-absent-root'), OLV_DEPLOY_PORT: '0' },
        stdio: 'ignore',
      });
      p.on('exit', (c) => res(c ?? -1));
    });
    expect(code).not.toBe(0);
  });
});

describe('the release workflow', () => {
  const yml = readFileSync(join(ROOT, '.github/workflows/release.yml'), 'utf8');
  const at = (needle: string) => yml.indexOf(needle);

  it('smokes the packaged archive after packaging', () => {
    const packaged = at('run: npm run package');
    const smoke = at('npm run test:smoke:deploy');
    expect(packaged).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(-1);
    expect(smoke).toBeGreaterThan(packaged);
  });

  it('smokes before anything assembles or uploads the payload', () => {
    // Packaging after a passing smoke would ship bytes the smoke never saw.
    expect(at('npm run test:smoke:deploy')).toBeLessThan(at('Assemble the flat release payload'));
  });

  it('names the archive explicitly rather than letting the script guess', () => {
    expect(yml).toMatch(/npm run test:smoke:deploy -- "\$ZIP"/);
  });

  it('carries the smoke result into the payload and the staged set', () => {
    expect(yml).toContain('cp "release/smoke-deploy-v${V}.json" release/payload/');
    expect(yml).toContain('cp "incoming/smoke-deploy-v${V}.json" "$STAGE"/');
  });

  it('does not repackage after the smoke has passed', () => {
    const smoke = at('npm run test:smoke:deploy');
    expect(yml.indexOf('npm run package', smoke)).toBe(-1);
  });
});

/**
 * The producer must never leave a success behind a failure.
 *
 * Clearing the result only inside `fail()` covered the explicit refusals and
 * nothing else: a throw from unzip, from port allocation or from Playwright
 * skipped that path, the process exited non-zero, and the PREVIOUS run's record
 * stayed on disk still claiming `ok` for an archive this run never validated.
 *
 * Each case stages a stale success first, so a passing assertion means the file
 * was actively removed rather than never written.
 *
 * The script resolves its paths from its own location, so these run in a
 * throwaway tree holding only what it reads. Nothing here can touch release/.
 */
describe('smoke-deploy-zip leaves no stale success', () => {
  const STALE = {
    schemaVersion: 1, project: 'openlidarviewer', version: '0.6.8', tag: 'v0.6.8',
    gitCommit: 'f'.repeat(40), archive: 'previous-run.zip', sha256: 'e'.repeat(64),
    checks: ['smoke.spec.ts'], ok: true,
  };

  /** A sandbox with the script, its contract, a package.json and a release dir. */
  function sandbox(zipBody: Buffer | string): { dir: string; zip: string; result: string } {
    const dir = mkdtempSync(join(tmpdir(), 'olv-producer-'));
    mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
    mkdirSync(join(dir, 'release'), { recursive: true });
    cpSync(join(ROOT, 'scripts/smoke-deploy-zip.mjs'), join(dir, 'scripts/smoke-deploy-zip.mjs'));
    cpSync(
      join(ROOT, 'scripts/lib/deploySmokeContract.mjs'),
      join(dir, 'scripts/lib/deploySmokeContract.mjs'),
    );
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.6.8' }));

    const zipName = 'openlidarviewer-v0.6.8-deploy-20260101-0000-root.zip';
    const zip = join(dir, 'release', zipName);
    writeFileSync(zip, zipBody);
    const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
    writeFileSync(join(dir, 'release/SHA256SUMS'), `${digest}  ${zipName}\n`);

    // The stale success from an earlier, real run.
    const result = join(dir, 'release/smoke-deploy-v0.6.8.json');
    writeFileSync(result, JSON.stringify(STALE));
    return { dir, zip, result };
  }

  const run = (dir: string, zip: string, env: Record<string, string> = {}) => {
    try {
      execFileSync(process.execPath, ['scripts/smoke-deploy-zip.mjs', zip], {
        cwd: dir, stdio: 'pipe', env: { ...process.env, ...env },
      });
      return 0;
    } catch (e) {
      return (e as { status?: number }).status ?? -1;
    }
  };

  it('removes it when extraction throws', () => {
    // Hashes correctly and is listed, so it passes every check up to unzip.
    const { dir, zip, result } = sandbox('this is not a zip archive');
    try {
      expect(existsSync(result)).toBe(true);
      expect(run(dir, zip)).not.toBe(0);
      expect(existsSync(result)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes it when the browser step fails', () => {
    // A real zip, so extraction succeeds and the run reaches Playwright. `npx`
    // is stubbed to fail, which is how a failing spec reaches this script: a
    // non-zero exit from the child, thrown by execFileSync.
    const src = mkdtempSync(join(tmpdir(), 'olv-zipsrc-'));
    writeFileSync(join(src, 'index.html'), '<!doctype html>');
    const zipPath = join(mkdtempSync(join(tmpdir(), 'olv-zipout-')), 'a.zip');
    execFileSync('zip', ['-rqX', zipPath, '.'], { cwd: src });
    const { dir, zip, result } = sandbox(readFileSync(zipPath));

    const binDir = mkdtempSync(join(tmpdir(), 'olv-bin-'));
    writeFileSync(join(binDir, 'npx'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    try {
      expect(existsSync(result)).toBe(true);
      expect(run(dir, zip, { PATH: `${binDir}:${process.env.PATH}` })).not.toBe(0);
      expect(existsSync(result)).toBe(false);
    } finally {
      for (const d of [dir, src, binDir, dirname(zipPath)]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it('leaves no partial temp file behind', () => {
    const { dir, zip } = sandbox('not a zip');
    try {
      run(dir, zip);
      expect(readdirSync(join(dir, 'release')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
