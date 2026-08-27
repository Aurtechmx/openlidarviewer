/**
 * toolPathReferences.test.ts
 *
 * A cited script has to exist.
 *
 * The curated catalog carried a note saying its URLs could be re-probed
 * with a FLAI verification script, and the FLAI contract test named a
 * second one. Neither was ever in the tree, and neither was the directory
 * they were said to live in. A reader auditing the catalog found a
 * verification story with nothing behind it, and the missing file is the
 * part nobody notices, because prose does not fail to compile. (The two
 * names are not written out here: this file is scanned like any other,
 * and a citation is a citation wherever it appears.)
 *
 * The check is against the filesystem, not against a list of known-good
 * names: a list would have to be updated by the same person who deleted
 * the script, which is the step that was missed in the first place.
 *
 * Scope is prose. Markdown is read whole; a source file is read only
 * where it comments, because a path inside a string literal is usually
 * test data or a value under construction rather than a claim about this
 * repository. A reference marked as retired is left alone: a note that a
 * script was removed names a file that is correctly absent.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');

/** Frozen evidence and the changelog record the past; they may cite what is gone. */
const HISTORICAL = [
  /^validation\/snapshot\//,
  /^docs\/validation\/evidence\//,
  /^docs\/releases\//,
  /^CHANGELOG\.md$/,
];

const SCANNED = /\.(ts|tsx|mjs|js|md|py|sh|yaml|yml)$/;
const TOOL_PATH = /(?:^|[`'"( ])((?:scripts|tools)\/[A-Za-z0-9._/-]+\.(?:mjs|js|ts|sh|py))/g;
const COMMENT = /^\s*(?:\/\/|\/\*|\*|#|<!--)/;
const RETIRED = /\bretired\b|\bremoved\b|\bdeleted\b|no longer/i;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f !== '' && SCANNED.test(f))
    .filter((f) => !HISTORICAL.some((re) => re.test(f)));
}

describe('referenced tool paths', () => {
  it('every script path named in prose exists', () => {
    const dangling: string[] = [];
    for (const file of trackedFiles()) {
      const isMarkdown = file.endsWith('.md');
      let text: string;
      try { text = readFileSync(resolve(REPO_ROOT, file), 'utf8'); } catch { continue; }
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!isMarkdown && !COMMENT.test(line)) return;
        // A retirement note may sit on the line below the reference.
        const window = `${line}\n${lines[i + 1] ?? ''}`;
        if (RETIRED.test(window)) return;
        for (const m of line.matchAll(TOOL_PATH)) {
          const ref = m[1];
          // Written relative to the document first, then to the root:
          // a README under validation/ names its own sibling scripts.
          const nearby = resolve(REPO_ROOT, dirname(file), ref);
          if (existsSync(nearby) || existsSync(resolve(REPO_ROOT, ref))) continue;
          dangling.push(`${file}:${i + 1} cites ${ref}, which does not exist`);
        }
      });
    }
    expect(dangling, dangling.join('\n')).toEqual([]);
  });
});
