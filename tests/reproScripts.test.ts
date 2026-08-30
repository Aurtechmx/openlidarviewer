/**
 * reproScripts.test.ts — the reproduction commands stay split so a missing
 * Python environment never fails the scientific numbers.
 *
 * `repro` used to chain the JS metrics and the Python figures with `&&`, so one
 * unguarded matplotlib import failed the whole command. The split keeps the
 * metrics Python-free; this pins that so the two never get re-merged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

describe('reproduction scripts', () => {
  it('repro:metrics is Python-free', () => {
    expect(pkg.scripts['repro:metrics']).toBeTruthy();
    expect(pkg.scripts['repro:metrics']).not.toMatch(/python/i);
  });

  it('repro:figures owns the Python figure step', () => {
    expect(pkg.scripts['repro:figures']).toMatch(/python3?\b.*plots\.py/);
  });

  it('repro runs metrics before figures', () => {
    expect(pkg.scripts['repro']).toBe('npm run repro:metrics && npm run repro:figures');
  });

  it('the figure environment is pinned in requirements-repro.txt', () => {
    const req = readFileSync(resolve(ROOT, 'requirements-repro.txt'), 'utf8');
    expect(req).toMatch(/^matplotlib==\d+\.\d+/m);
  });
});
