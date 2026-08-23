#!/usr/bin/env node
/**
 * verify-reference-reproducibility.mjs — re-run each committed reference command
 * and check the bytes still match.
 *
 * WHY THIS EXISTS. Two reproducibility failures happened on one machine within
 * an hour, and no gate noticed either. A Homebrew upgrade moved GDAL from 3.13.1
 * to 3.13.3 while the validation corpus cited 3.13.1 in about 390 places; and
 * PDAL began aborting in dyld because a transitive library had been upgraded
 * underneath it, leaving the primary oracle for several E4 claims silently
 * unusable. The cross-check tests did not fail, because they read committed
 * bytes rather than re-running the tool. That is the right design for a test,
 * and it means nothing at all was watching the tool.
 *
 * WHY THIS CHECKS BYTES AND NOT VERSIONS. The obvious guard compares the live
 * tool version against the recorded one. It was tried and rejected: GDAL 3.13.3
 * reproduces every committed gdaldem reference here byte for byte, so a version
 * guard would fail today over a drift that provably changes nothing. A gate that
 * cries wolf gets switched off. What matters is whether the reference is still
 * reproducible, so that is what is measured.
 *
 * WHAT A MISSING TOOL MEANS. Absence is not failure. Several legs in this repo
 * already record `status: failed` and report themselves unavailable rather than
 * fabricating a reference, and CI does not carry GDAL. A reference whose tool is
 * not installed is reported `skipped` and does not fail the run. Only a tool
 * that IS present and produces different bytes is an error.
 *
 * Exit 0 = every reproducible reference reproduced; exit 1 = at least one drifted.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REF_DIR = join(ROOT, 'tests/fixtures/reference');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** Split a recorded command line into argv, honouring nothing exotic. */
function argvOf(line) {
  return line.trim().split(/\s+/).filter(Boolean);
}

/**
 * The committed output a reference directory holds. Named `<product>-gdal.<ext>`
 * by every generator here, and it is the argv token the rerun must redirect.
 */
function committedOutput(dir) {
  return readdirSync(dir).find((f) => /-gdal\.[a-z]+$/i.test(f)) ?? null;
}

const results = [];
for (const name of readdirSync(REF_DIR).sort()) {
  const dir = join(REF_DIR, name);
  const cmdFile = join(dir, 'command.txt');
  if (!existsSync(cmdFile)) continue;
  const out = committedOutput(dir);
  if (!out) { results.push({ name, status: 'no-output', detail: 'no *-gdal.* artifact' }); continue; }

  const argv = argvOf(readFileSync(cmdFile, 'utf8').split('\n')[0]);
  const tool = argv[0];
  const where = spawnSync('/usr/bin/which', [tool], { encoding: 'utf8' });
  if (where.status !== 0) { results.push({ name, status: 'skipped', detail: `${tool} not installed` }); continue; }

  const tmp = mkdtempSync(join(tmpdir(), 'olv-refcheck-'));
  try {
    const outIdx = argv.indexOf(out);
    if (outIdx < 0) { results.push({ name, status: 'unparsed', detail: `output ${out} not in command` }); continue; }
    const rerunArgv = argv.slice(1);
    rerunArgv[outIdx - 1] = join(tmp, out);
    const r = spawnSync(tool, rerunArgv, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) {
      results.push({ name, status: 'tool-failed', detail: (r.stderr || '').trim().split('\n')[0] || `exit ${r.status}` });
      continue;
    }
    const produced = join(tmp, out);
    if (!existsSync(produced)) { results.push({ name, status: 'tool-failed', detail: 'no output written' }); continue; }
    const same = sha256(produced) === sha256(join(dir, out));
    results.push({ name, status: same ? 'reproduced' : 'drifted', detail: same ? out : `${out} differs` });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const drifted = results.filter((r) => r.status === 'drifted');
const failed = results.filter((r) => r.status === 'tool-failed');
for (const r of results) {
  const mark = r.status === 'reproduced' ? 'ok' : r.status === 'skipped' ? '--' : '!!';
  console.log(`  ${mark} ${r.name.padEnd(12)} ${r.status.padEnd(12)} ${r.detail}`);
}
if (drifted.length || failed.length) {
  console.error('\nverify:reference-reproducibility FAILED');
  for (const r of drifted) {
    console.error(`  • ${r.name}: the committed reference no longer reproduces. The tool that`);
    console.error(`    generated it has changed behaviour. Do not regenerate the fixture to make`);
    console.error(`    this pass: record which tool version produced which bytes, and decide`);
    console.error(`    whether the claim resting on it still holds.`);
  }
  for (const r of failed) {
    console.error(`  • ${r.name}: the tool is installed but failed to run (${r.detail}).`);
    console.error(`    An oracle that cannot execute is not an oracle. Fix the install.`);
  }
  process.exit(1);
}
const n = results.filter((r) => r.status === 'reproduced').length;
const s = results.filter((r) => r.status === 'skipped').length;
console.log(`\nverify:reference-reproducibility OK — ${n} reference(s) reproduced, ${s} skipped for an absent tool.`);
