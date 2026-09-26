#!/usr/bin/env node
/**
 * smoke-deploy-zip.mjs — start the ZIP that will actually ship, and bind the
 * result to that ZIP's digest.
 *
 * The release chain ran its smoke against a build, then packaged a SECOND build
 * and shipped that one. The two come from the same commit and are expected to
 * agree, but "expected to agree" is not a test: nothing started the bytes in
 * the archive, so a packaging fault — a missing asset, a mode that makes a file
 * unreadable, a rewrite that corrupts an entry — would reach users with a green
 * release. It already hid a real one: the shipped bundle fetched a loaders.gl
 * worker from unpkg.com, which the deploy's own Content-Security-Policy blocks,
 * and no leg could see it because `vite preview` applies no CSP.
 *
 * This verifies the archive's SHA-256 against the checksum file, extracts it,
 * serves the extracted tree with no build step and no test seam, runs the smoke
 * against it, and writes a result naming the archive, its digest and the commit
 * tested. The digest is the binding: a result that does not name the shipped
 * file's digest is a result about some other bytes.
 *
 * Usage: node scripts/smoke-deploy-zip.mjs [path/to/deploy-root.zip]
 *        (defaults to the newest deploy ZIP in release/)
 *
 * Writes: release/smoke-deploy-v<version>.json
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import {
  readFileSync, writeFileSync, renameSync, existsSync, readdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOY_SMOKE_SCHEMA_VERSION, DEPLOY_SMOKE_PROJECT, REQUIRED_SMOKE_CHECKS,
} from './lib/deploySmokeContract.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'release');

const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const RESULT_FILE = join(RELEASE, `smoke-deploy-v${VERSION}.json`);

// The result of the PREVIOUS run is deleted before anything else happens.
// Clearing it only inside fail() was not enough: a throw from unzip, from port
// allocation or from Playwright skipped that path entirely, the process exited
// non-zero, and the earlier success record stayed on disk still claiming `ok`
// for an archive this run never validated. Removing it up front means the file
// exists only when THIS run wrote it.
rmSync(RESULT_FILE, { force: true });

const fail = (msg) => {
  console.error(`smoke:deploy FAILED — ${msg}`);
  // Belt and braces: nothing should have written it by now, but an absent
  // result and a failed one must be the same thing to the verifier.
  rmSync(RESULT_FILE, { force: true });
  process.exit(1);
};

/** The newest `*-deploy-*-root.zip` in release/, or null when there is none. */
function newestDeployZip() {
  if (!existsSync(RELEASE)) return null;
  const zips = readdirSync(RELEASE).filter((f) => /-deploy-.*-root\.zip$/.test(f)).sort();
  return zips.length ? join(RELEASE, zips[zips.length - 1]) : null;
}

/**
 * A port nothing is listening on, so a stray server cannot be mistaken for ours.
 *
 * Asking the kernel for port 0 and reading back what it assigned is the only
 * way to get a port that is free NOW; a fixed default can be occupied, and with
 * reuseExistingServer off that occupation is a confusing failure rather than a
 * silent pass. There is a race between closing this probe and Playwright
 * binding, but it is between two processes on one machine seconds apart, and
 * losing it fails loudly rather than passing wrongly.
 */
function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

const zip = process.argv[2] ? resolve(process.argv[2]) : newestDeployZip();
if (!zip || !existsSync(zip)) fail('no deploy ZIP found — run `npm run package` first');

const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');

// The checksum file is the release's own claim about these bytes. Checking the
// archive against it here means the smoke and the published checksum cannot
// describe different files.
const sums = join(RELEASE, 'SHA256SUMS');
if (!existsSync(sums)) fail('release/SHA256SUMS is missing — the digest has nothing to bind to');
const line = readFileSync(sums, 'utf8').split('\n').find((l) => l.includes(basename(zip)));
if (!line) fail(`${basename(zip)} is not listed in SHA256SUMS`);
const claimed = line.trim().split(/\s+/)[0];
if (claimed !== digest) fail(`SHA256SUMS says ${claimed} but the file on disk is ${digest}`);

/** The commit these bytes were built from, or null outside a repository. */
function headCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const work = mkdtempSync(join(tmpdir(), 'olv-deploy-smoke-'));
try {
  execFileSync('unzip', ['-q', zip, '-d', work], { stdio: 'inherit' });
  // THROWN, not fail(): fail() calls process.exit, which ends the process
  // immediately and skips the finally below, so this refusal left its
  // extraction directory behind. Inside the try, an Error routes through the
  // catch (non-zero exit, no result) and the finally (cleanup) already here.
  if (!existsSync(join(work, 'index.html'))) {
    throw new Error('the archive has no index.html at its root');
  }
  // The licence and the third-party notices ship inside the archive, or the
  // archive does not ship.
  for (const legal of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (!existsSync(join(work, legal))) throw new Error(`the archive has no ${legal} at its root`);
  }

  const port = await freePort();
  console.log(`smoke:deploy — ${basename(zip)}\n  sha256 ${digest}\n  port ${port}`);
  execFileSync(
    'npx',
    ['playwright', 'test', '--project=deterministic',
      'tests/e2e/smoke.spec.ts', 'tests/e2e/lazyChunkLoad.spec.ts'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      // The directory travels as an environment variable, never as shell text,
      // so a path containing spaces cannot split into two arguments.
      // OLV_DEPLOY_ROOT also forces reuseExistingServer off in the config: a
      // server someone left on the port would otherwise answer for the archive
      // and the run would pass without touching it.
      env: {
        ...process.env,
        OLV_DEPLOY_ROOT: work,
        OLV_DEPLOY_PORT: String(port),
        SMOKE_LIVE: '1',
      },
    },
  );

  // Written only here, after every required check has passed, and written
  // atomically: a partial file from an interrupted write would be a result the
  // verifier reads as malformed rather than as absent, which is a worse
  // failure to diagnose than no file at all.
  const result = {
    schemaVersion: DEPLOY_SMOKE_SCHEMA_VERSION,
    project: DEPLOY_SMOKE_PROJECT,
    version: VERSION,
    tag: `v${VERSION}`,
    gitCommit: headCommit(),
    archive: basename(zip),
    sha256: digest,
    checks: [...REQUIRED_SMOKE_CHECKS],
    ok: true,
    nodeVersion: process.version,
    generatedAt: new Date().toISOString(),
  };
  const tmp = `${RESULT_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(tmp, RESULT_FILE);
  console.log(`\nsmoke:deploy OK — ${result.archive} sha256:${digest}`);
  console.log(`  result: ${RESULT_FILE}`);
} catch (err) {
  // Any throw on the way — extraction, port allocation, Playwright's non-zero
  // exit — must end as a failure with no result behind it.
  console.error(`smoke:deploy FAILED — ${err?.message ?? err}`);
  rmSync(RESULT_FILE, { force: true });
  rmSync(`${RESULT_FILE}.tmp`, { force: true });
  process.exitCode = 1;
} finally {
  // Runs on the success path and on every failure path, so a failed run does
  // not leave the extracted archive behind.
  rmSync(work, { recursive: true, force: true });
}
