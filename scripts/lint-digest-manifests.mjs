#!/usr/bin/env node
/**
 * lint-digest-manifests.mjs: check that committed digest manifests still hold.
 *
 * A `SHA256SUMS` file states that a set of bytes has not changed since someone
 * recorded them. Two of them, `validation/terrain-field/SHA256SUMS` and
 * `validation/terrain-field/coconino/SHA256SUMS`, were read by nothing: a
 * digest could be edited to zeros and `validation:field:verify`, `test:terrain`
 * and `verify:archive-gate` all stayed green. A manifest nothing verifies is
 * worse than no manifest, because it reads as assurance.
 *
 * Every entry whose file is committed is recomputed and compared. Entries whose
 * file is absent are counted, not failed: several manifests under
 * `validation/cross-implementation/` record outputs a reference tool
 * regenerates, and those bytes are deliberately not in the tree. A manifest
 * with no present file at all is reported as unverifiable here rather than
 * passed silently, so the distinction stays visible.
 *
 * `collectDigestProblems` is a function of its accessors so the cases in
 * tests/digestManifestLint.test.ts are about the rules rather than about
 * whatever the repository holds today.
 *
 * Usage: `node scripts/lint-digest-manifests.mjs`, also
 * `npm run lint:digest-manifests`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

/** Directories searched for manifests. Anything outside them is not evidence. */
export const SEARCH_ROOTS = ['validation', 'tests/fixtures'];

/** A digest manifest is one of these names, matching what the tree already uses. */
export function isManifestName(name) {
  return name === 'SHA256SUMS' || name === 'SHA256SUMS.txt' || name.endsWith('-SHA256SUMS');
}

/** Parse `<sha256>  <path>` lines. Returns entries and malformed line numbers. */
export function parseManifest(text) {
  const entries = [];
  const malformed = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (!m) malformed.push(i + 1);
    else entries.push({ sha256: m[1], path: m[2] });
  });
  return { entries, malformed };
}

/**
 * Collect every digest problem.
 *
 * `listFiles(dir)` returns the manifest paths under `dir`, `readText(p)` the
 * manifest text, and `digestOf(p)` the file's sha256 or null when it is absent.
 */
export function collectDigestProblems({ listFiles, readText, digestOf }) {
  const problems = [];
  const summary = { manifests: 0, checked: 0, absent: 0, unverifiable: [] };

  for (const root of SEARCH_ROOTS) {
    for (const manifest of listFiles(root)) {
      summary.manifests += 1;
      const { entries, malformed } = parseManifest(readText(manifest) ?? '');
      for (const line of malformed) {
        problems.push(`${manifest}:${line} is not a "<sha256>  <path>" line.`);
      }
      if (entries.length === 0 && malformed.length === 0) {
        problems.push(`${manifest} lists nothing. Remove it or record the bytes it stands for.`);
        continue;
      }
      let present = 0;
      for (const e of entries) {
        const target = join(dirname(manifest), e.path);
        const actual = digestOf(target);
        if (actual == null) {
          summary.absent += 1;
          continue;
        }
        present += 1;
        summary.checked += 1;
        if (actual !== e.sha256) {
          problems.push(
            `${manifest} records ${e.sha256.slice(0, 12)}… for ${e.path}, but the file ` +
              `hashes to ${actual.slice(0, 12)}…. Either the bytes changed and the ` +
              `manifest was not repinned, or the manifest was edited.`,
          );
        }
      }
      if (present === 0) summary.unverifiable.push(manifest);
    }
  }
  return { problems, summary };
}

/** File contents, or null when nothing is there. Other IO failures still throw. */
function readOr(abs, encoding) {
  try {
    return encoding ? readFileSync(abs, encoding) : readFileSync(abs);
  } catch (err) {
    const code = err && err.code;
    if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
    throw err;
  }
}

if (isCliEntry(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(resolve(ROOT, dir), { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
      throw err;
    }
    return entries.flatMap((e) =>
      e.isDirectory()
        ? walk(join(dir, e.name))
        : isManifestName(e.name)
          ? [join(dir, e.name)]
          : [],
    );
  };
  const { problems, summary } = collectDigestProblems({
    listFiles: walk,
    // Read first and classify the failure, rather than asking whether the file
    // exists and then reading it. The two answers can disagree, and a check
    // that is separately true is not a guarantee at the moment of the read.
    // Only "there is no such file" means absent. Anything else, a permissions
    // failure or a truncated read, is a real problem and is not reported as a
    // regenerated output that happens to be missing.
    readText: (p) => readOr(resolve(ROOT, p), 'utf8'),
    digestOf: (p) => {
      const bytes = readOr(resolve(ROOT, p), null);
      return bytes == null ? null : createHash('sha256').update(bytes).digest('hex');
    },
  });

  if (problems.length === 0) {
    const note = summary.unverifiable.length
      ? `; ${summary.unverifiable.length} manifest(s) record regenerated outputs not in the tree`
      : '';
    console.log(
      `lint:digest-manifests OK — ${summary.checked} digest(s) across ` +
        `${summary.manifests} manifest(s) match their files${note}.`,
    );
    process.exit(0);
  }
  console.error('lint:digest-manifests FAILED');
  console.error('');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('');
  process.exit(1);
}
