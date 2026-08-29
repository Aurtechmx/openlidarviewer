/**
 * dependenciesDocSync.test.ts — docs/project/DEPENDENCIES.md is a committed
 * baseline that restates resolved dependency versions, the release line, and
 * the SBOM root reference. Those figures drift silently every time a
 * dependency is bumped or the version rolls, and nothing compared the prose
 * against package-lock.json or package.json. These tests bind each restated
 * figure to its source of truth so a stale baseline fails the suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');

const doc = read('docs/project/DEPENDENCIES.md');
const pkg = JSON.parse(read('package.json')) as { version: string };
const lock = JSON.parse(read('package-lock.json')) as {
  packages: Record<string, { version?: string }>;
};

/** Every `| name | range | resolved | ... |` row whose name is a real package. */
function docRows(): Array<{ name: string; resolved: string }> {
  const rows: Array<{ name: string; resolved: string }> = [];
  for (const line of doc.split('\n')) {
    const m = line.match(/^\|\s*(@?[\w./-]+)\s*\|\s*(?:[\^~][\d.]+|[\d.]+)\s*\|\s*([\d.]+)\s*\|/);
    if (!m) continue;
    const name = m[1].trim();
    if (lock.packages[`node_modules/${name}`]) rows.push({ name, resolved: m[2].trim() });
  }
  return rows;
}

describe('DEPENDENCIES.md stays in sync with its sources', () => {
  it('lists real package rows to compare', () => {
    expect(docRows().length).toBeGreaterThan(5);
  });

  it('every restated resolved version matches package-lock.json', () => {
    const drift = docRows()
      .map(({ name, resolved }) => ({ name, resolved, lock: lock.packages[`node_modules/${name}`].version }))
      .filter((r) => r.resolved !== r.lock);
    expect(drift).toEqual([]);
  });

  it('the release line names the current package version', () => {
    const m = doc.match(/^\|\s*Release line\s*\|\s*v([\d.]+)\s*\|/m);
    expect(m, 'no "Release line" row found').not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });

  it('the SBOM root reference names the current package version', () => {
    const m = doc.match(/root `openlidarviewer@([\d.]+)`/);
    expect(m, 'no SBOM root reference found').not.toBeNull();
    expect(m![1]).toBe(pkg.version);
  });
});
