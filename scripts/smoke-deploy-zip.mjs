#!/usr/bin/env node
/**
 * smoke-deploy-zip.mjs — start the ZIP that will actually ship, and bind the
 * result to that ZIP's digest.
 *
 * The release chain ran its smoke against a build, then packaged a SECOND build
 * and shipped that one. The two are produced from the same commit and are
 * expected to agree, but "expected to agree" is not a test: nothing started the
 * bytes in the archive, so a packaging fault — a missing asset, a mode that
 * makes a file unreadable, a rewrite that corrupts an entry — would reach users
 * with a green release.
 *
 * This verifies the archive's SHA-256 against the checksum file, extracts it,
 * serves the extracted tree with no build step and no test seam, runs the smoke
 * against it, and prints the digest it tested. The digest is the binding: a
 * result that does not name the shipped file's digest is a result about some
 * other bytes.
 *
 * Usage: node scripts/smoke-deploy-zip.mjs [path/to/deploy-root.zip]
 *        (defaults to the newest deploy ZIP in release/)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  readFileSync, existsSync, readdirSync, mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = join(ROOT, 'release');

const fail = (msg) => { console.error(`smoke:deploy FAILED — ${msg}`); process.exit(1); };

/** The newest `*-deploy-*-root.zip` in release/, or null when there is none. */
function newestDeployZip() {
  if (!existsSync(RELEASE)) return null;
  const zips = readdirSync(RELEASE)
    .filter((f) => /-deploy-.*-root\.zip$/.test(f))
    .sort();
  return zips.length ? join(RELEASE, zips[zips.length - 1]) : null;
}

const zip = process.argv[2] ? resolve(process.argv[2]) : newestDeployZip();
if (!zip || !existsSync(zip)) fail('no deploy ZIP found — run `npm run package` first');

const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');

// The checksum file is the release's own claim about these bytes. Checking the
// archive against it here means the smoke and the published checksum cannot
// describe different files.
const sums = join(RELEASE, 'SHA256SUMS');
if (existsSync(sums)) {
  const line = readFileSync(sums, 'utf8').split('\n').find((l) => l.includes(basename(zip)));
  if (!line) fail(`${basename(zip)} is not listed in SHA256SUMS`);
  const claimed = line.trim().split(/\s+/)[0];
  if (claimed !== digest) {
    fail(`SHA256SUMS says ${claimed} but the file on disk is ${digest}`);
  }
} else {
  fail('release/SHA256SUMS is missing — the digest has nothing to be bound to');
}

const work = mkdtempSync(join(tmpdir(), 'olv-deploy-smoke-'));
try {
  execFileSync('unzip', ['-q', zip, '-d', work], { stdio: 'inherit' });
  if (!existsSync(join(work, 'index.html'))) {
    fail('the archive has no index.html at its root');
  }
  console.log(`smoke:deploy — ${basename(zip)}\n  sha256 ${digest}\n  extracted to ${work}`);
  execFileSync(
    'npx',
    ['playwright', 'test', '--project=deterministic', 'tests/e2e/smoke.spec.ts', 'tests/e2e/lazyChunkLoad.spec.ts'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      // OLV_DEPLOY_ROOT switches the Playwright webServer to serve these bytes.
      // SMOKE_LIVE keeps the seam-less expectations of the live leg: the shipped
      // bundle carries no `?test=1` API, and a run that needed one would not be
      // testing what users get.
      env: { ...process.env, OLV_DEPLOY_ROOT: work, SMOKE_LIVE: '1' },
    },
  );
  console.log(`\nsmoke:deploy OK — ${basename(zip)} sha256:${digest}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
