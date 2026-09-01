/**
 * oneDtmPath.test.ts: a STATIC guard that production DTM construction converges
 * on ONE canonical implementation.
 *
 * #830 already proves at RUNTIME that the checkpoint validator's DTM is the
 * cell-for-cell equal of `computeTerrainCore`'s. This test is the compile-time
 * complement: it asserts that every path which builds a bare-earth DTM routes
 * through the shared rasterise + surface-build primitives —
 *   `rasterizeDtm`          (median/mean per-cell aggregation of ground returns)
 *   `buildSurfaceFromRaster` (despike -> geodesic void-fill -> guarded confidence)
 * — rather than reimplementing aggregation, despike or fill on its own.
 *
 * Two ways a second implementation could creep in, both caught here:
 *
 *   1. A DTM-building module stops importing the shared builder and grows its
 *      own scatter/fill. Guarded by (B): the known producers must import both
 *      primitives.
 *   2. The despike / geodesic-fill / confidence primitives get imported OUTSIDE
 *      the ground core to wire up a competing surface. Guarded by (C): those
 *      primitives are owned by `src/terrain/ground/` and imported nowhere else.
 *
 * The primitives themselves are asserted to have exactly one definition each
 * (A), so "the shared builder" names a single function, not a family.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'src');
const posix = (p: string) => p.split(sep).join('/');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC).map((abs) => ({
  rel: posix(relative(ROOT, abs)),
  text: readFileSync(abs, 'utf8'),
}));

/** Value (non-type-only) import specifiers a file declares. */
function valueImports(text: string): string[] {
  const specs: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\b([^;\n]*?)\bfrom\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const clause = m[1];
    // `import type { … } from` / `export type { … } from` are erased — skip.
    if (/^\s*type\b/.test(clause)) continue;
    specs.push(m[2]);
  }
  return specs;
}

/** Count of `export function NAME(` across the tree. */
function definitionCount(name: string): number {
  let n = 0;
  for (const f of FILES) {
    const re = new RegExp(`export function ${name}\\s*\\(`, 'g');
    n += (f.text.match(re) ?? []).length;
  }
  return n;
}

describe('one canonical DTM path', () => {
  // (A) The shared primitives are singletons: "the shared builder" is one
  //     function, so routing through it is unambiguous.
  it('defines each shared DTM primitive exactly once', () => {
    expect(definitionCount('rasterizeDtm')).toBe(1);
    expect(definitionCount('buildSurfaceFromRaster')).toBe(1);
  });

  // (B) Every known DTM-constructing path imports BOTH shared primitives.
  it('routes every known DTM producer through rasterizeDtm + buildSurfaceFromRaster', () => {
    const producers = [
      'src/terrain/contour/analyseContours.ts', // computeTerrainCore (the delivered surface)
      'src/terrain/validate/dtmSurfaceModel.ts', // DtmSurfaceModel (blocked cross-validation)
      'src/terrain/validate/holdoutRmse.ts', // hold-out / checkpoint reducer
      'src/terrain/change/compareEpochs.ts', // candidate epoch-surface generator
    ];
    for (const rel of producers) {
      const f = FILES.find((x) => x.rel === rel);
      expect(f, `${rel} is missing — update this guard if the DTM producer moved`).toBeTruthy();
      const imps = valueImports(f!.text);
      const usesRaster = imps.some((s) => /\/rasterizeDtm$/.test(s) || s.endsWith('ground/rasterizeDtm'));
      const usesBuilder = imps.some((s) => /\/surfaceFromRaster$/.test(s) || s.endsWith('ground/surfaceFromRaster'));
      expect(usesRaster, `${rel} must import rasterizeDtm`).toBe(true);
      expect(usesBuilder, `${rel} must import buildSurfaceFromRaster`).toBe(true);
    }
  });

  // (C) The despike and geodesic void-fill primitives — the two steps that turn
  //     a raster of measured cells into a delivered bare-earth surface — are
  //     OWNED by the ground core. No module outside src/terrain/ground/ may
  //     value-import them, which is how a second surface builder would have to
  //     reach them. (cellConfidence is deliberately NOT here: it is a shared
  //     cell-status/confidence module read all over the terrain layer, not a
  //     surface-assembly step.)
  it('confines the despike + geodesic-fill surface primitives to the ground core', () => {
    const strays: string[] = [];
    for (const f of FILES) {
      if (f.rel.startsWith('src/terrain/ground/')) continue;
      for (const spec of valueImports(f.text)) {
        // Match only the ground-relative module, not an unrelated same-named file.
        if (/(^|\/)(despike|geodesicFill)$/.test(spec)) {
          strays.push(`${f.rel} -> ${spec}`);
        }
      }
    }
    expect(
      strays,
      'these files reach a ground-core DTM primitive from outside src/terrain/ground/ — ' +
        'a candidate second DTM path; route through buildSurfaceFromRaster instead:\n' +
        strays.join('\n'),
    ).toEqual([]);
  });

  // (D) Both terrain-raster backends delegate the median DTM scatter to the CPU
  //     rasterizeDtm rather than growing a parallel GPU/CPU aggregator: the
  //     backend contract's `gridFromPoints` slot is filled by rasterizeDtm.
  it('wires both engine backends to rasterizeDtm for the DTM scatter', () => {
    for (const rel of ['src/terrain/engine/cpuBackend.ts', 'src/terrain/engine/gpuBackend.ts']) {
      const f = FILES.find((x) => x.rel === rel);
      expect(f, `${rel} is missing`).toBeTruthy();
      expect(f!.text).toMatch(/gridFromPoints:\s*rasterizeDtm/);
    }
  });
});
