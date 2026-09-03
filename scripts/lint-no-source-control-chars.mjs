#!/usr/bin/env node
/**
 * lint-no-source-control-chars.mjs — no shipped source file may embed a raw
 * control byte.
 *
 * Four tracked files used a literal 0x00 byte as a string separator or a
 * sentinel id. The runtime values were correct, and that is exactly why the
 * problem survived: nothing in the test suite can see the difference between a
 * NUL written as a byte and a NUL written as `\0`. The difference is in the
 * source representation. Git, diff viewers, review tooling and most greps
 * classify a file containing 0x00 as binary, so a TypeScript module stops
 * showing a textual diff and stops being searchable. This tree ships as an
 * official source archive, so the representation is part of the deliverable.
 *
 * The fix at each site was to write the same character as an escape. The
 * sentinel is unchanged; only its spelling in the file changed.
 *
 * WHAT IS REJECTED. C0 controls other than the three that structure text:
 * 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F. Tab (0x09), LF (0x0A) and CR (0x0D) are
 * allowed, since they are how a text file is laid out rather than data smuggled
 * into a literal. DEL (0x7F) is not in the range, so this does not claim to
 * cover it.
 *
 * WHAT IS SCANNED. The extensions this repository ships as source: .ts, .mjs,
 * .js, .json, .md, .css, .html, .yml. Binary fixtures are excluded by that
 * extension filter alone, not by a path list, which is why no fixture path
 * needs an exemption: every .las, .laz, .e57, .tif, .png and .f32 under
 * tests/fixtures and validation/ is outside the scanned set by extension.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';

const GIT = requireBinaryOnPath('git');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Extensions this repository ships as readable source. */
const SOURCE_EXTENSIONS = ['.ts', '.mjs', '.js', '.json', '.md', '.css', '.html', '.yml'];

/** Directories a filesystem walk must not enter: never tracked, or generated. */
const WALK_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  'test-results',
  'coverage',
  'playwright-report',
  '.venv',
  '__pycache__',
]);

/**
 * Files that describe the byte rather than contain one.
 *
 * This file names the range it rejects, and it does so in prose and in code,
 * so it must not be read as a finding against itself.
 */
const DESCRIBES_THE_PATTERN = new Set(['scripts/lint-no-source-control-chars.mjs']);

/** True when a byte is a C0 control other than tab, LF or CR. */
function isForbidden(byte) {
  if (byte === 0x09 || byte === 0x0a || byte === 0x0d) return false;
  return byte <= 0x08 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte <= 0x1f);
}

/** True when a filesystem walk was used because there is no git history. */
let archiveMode = false;

/**
 * Every tracked file, since anything tracked reaches the source archive.
 * An archive carries no `.git`, and a check that cannot run must not report
 * success, so the fallback walks the tree the archive ships.
 */
function trackedFiles() {
  try {
    return execFileSync(GIT, ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  } catch {
    archiveMode = true;
    const files = [];
    const walk = (rel) => {
      for (const entry of readdirSync(resolve(ROOT, rel === '' ? '.' : rel), {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink()) continue;
        if (WALK_SKIP.has(entry.name)) continue;
        const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) walk(next);
        else files.push(next);
      }
    };
    walk('');
    return files;
  }
}

function isSourceFile(path) {
  if (path.split('/').some((segment) => WALK_SKIP.has(segment))) return false;
  return SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** Every forbidden byte in one file, reported with its 1-based line number. */
function findings(path) {
  let buf;
  try {
    buf = readFileSync(resolve(ROOT, path));
  } catch {
    return [];
  }
  const hits = [];
  let line = 1;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i];
    if (byte === 0x0a) {
      line += 1;
      continue;
    }
    if (isForbidden(byte)) {
      hits.push({ line, byte, offset: i });
      if (hits.length >= 5) break; // One file's fix is the same for all of them.
    }
  }
  return hits;
}

const problems = [];
let scanned = 0;
for (const file of trackedFiles()) {
  if (!isSourceFile(file)) continue;
  if (DESCRIBES_THE_PATTERN.has(file)) continue;
  scanned += 1;
  for (const hit of findings(file)) {
    const hex = `0x${hit.byte.toString(16).padStart(2, '0').toUpperCase()}`;
    problems.push(`${file}:${hit.line}: raw control byte ${hex} at offset ${hit.offset}`);
  }
}

if (scanned === 0) {
  console.error('lint:no-source-control-chars FAILED\n');
  console.error('  • No source file was scanned, so nothing was checked.');
  console.error('\nA check that cannot run must not report success.');
  process.exit(1);
}

if (problems.length > 0) {
  console.error('lint:no-source-control-chars FAILED\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\nA raw control byte makes a text file read as binary: diff, grep and');
  console.error('review tooling stop showing its contents, and this tree ships as a');
  console.error('source archive. Write the character as an escape in the string');
  console.error('literal instead, for example \\0, so the runtime value is unchanged');
  console.error('and the file stays searchable UTF-8.');
  process.exit(1);
}

console.log(
  `lint:no-source-control-chars OK — ${scanned} ${archiveMode ? 'walked (archive mode: no git history)' : 'tracked'} ` +
    'source file(s) carry no raw control byte outside tab, LF and CR.',
);
