/**
 * eagerImportGraph.test.ts
 *
 * Source-level guard on the startup shell: walks the static (non-type) import
 * graph from src/main.ts and fails if it reaches a subsystem that must load on
 * demand. Dynamic `import()` calls are code-splitting boundaries and are not
 * followed; `import type` / `export type` are erased and are not followed.
 *
 * Complements tests/chunkIsolation.test.ts (post-build content fingerprints)
 * and scripts/check-bundle-budget.mjs (byte ceilings): those catch weight in the
 * built shell, this names the module that pulled it in, without a build.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..');
const ENTRY = join(ROOT, 'src', 'main.ts');

/** Paths (relative to the repo root) the eager graph must never contain. */
export const LAZY_ONLY = [
  'src/simulation/',
  'src/ui/fieldSimulation/',
  'src/app/diagnostics/copyDiagnostics.ts',
  'src/app/diagnostics/errorLedger.ts',
  'src/platform/capabilityProbe.ts',
  'src/platform/runtimeFormFactor.ts',
  'src/render/deviceNotice.ts',
  'src/perf/navProbe.ts',
  'src/perf/navProbeHook.ts',
  'src/perf/navProbeInstall.ts',
  'src/perf/navJankRecord.ts',
  'src/perf/navDriver.ts',
  'src/perf/navTrajectories.ts',
  'src/perf/navDriverLoader.ts',
];

/** A path with POSIX separators, so the checks read the same on Windows. */
export const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** Repo-relative POSIX path of an absolute source file. */
const rel = (f: string): string => toPosix(relative(ROOT, f));

const STATIC_IMPORT = /(?:^|\n)[ \t]*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile() && /\.tsx?$/.test(candidate)) return candidate;
  }
  return null;
}

/** Every source file reachable from `entry` through runtime static imports, with the importer that reached it. */
export function eagerGraph(entry: string): Map<string, string | null> {
  const seen = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(STATIC_IMPORT)) {
      if (m[1]) continue; // import type / export type
      const target = resolveSpecifier(file, m[2]);
      if (!target || seen.has(target)) continue;
      seen.set(target, file);
      queue.push(target);
    }
  }
  return seen;
}

function chain(graph: Map<string, string | null>, file: string): string {
  const parts: string[] = [];
  for (let f: string | null | undefined = file; f; f = graph.get(f)) parts.unshift(rel(f));
  return parts.join(' -> ');
}

describe('eager entry import graph', () => {
  const graph = eagerGraph(ENTRY);
  const files = [...graph.keys()].map(rel);

  it('normalises backslash paths to POSIX separators', () => {
    expect(toPosix('src\\app\\staleChunkReload.ts')).toBe('src/app/staleChunkReload.ts');
    expect(toPosix('src/lazyChunks.ts')).toBe('src/lazyChunks.ts');
  });

  it('walks a real graph, so the check below is not vacuous', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('src/app/staleChunkReload.ts');
    expect(files).toContain('src/lazyChunks.ts');
  });

  it('matches every forbidden prefix against the same path form it reports', () => {
    for (const prefix of LAZY_ONLY) expect(prefix).toBe(toPosix(prefix));
    expect(files.some((f) => f.startsWith('src/app/'))).toBe(true);
  });

  it.each(LAZY_ONLY)('does not statically reach %s', (prefix) => {
    const hits = [...graph.keys()].filter((f) => rel(f).startsWith(prefix));
    expect(hits.map((f) => chain(graph, f))).toEqual([]);
  });
});
