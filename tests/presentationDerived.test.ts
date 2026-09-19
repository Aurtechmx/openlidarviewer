import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Coverage sizing derives a per-point number from a cloud's own positions and
 * hands it to the GPU. It describes how the cloud is drawn, not what was
 * measured, and the source records are never touched to produce it.
 *
 * Nothing stops it travelling, though. A session that saved it, or an export
 * that wrote it beside the returns, would put a presentation figure into a file
 * a reader takes for data, and the value would look exactly like a measurement
 * because it is a float per point. So the boundary is held here rather than by
 * everyone remembering: the surfaces that write a session or a point file do
 * not name the render-only attributes.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Attributes that exist to draw with and for no other reason. */
const RENDER_ONLY_ATTRIBUTES = ['aSize', 'olvNodeResolution', 'olvRootResolution'];

/** Everything that writes a session or a point file a reader keeps. */
const PERSISTING_SURFACE = ['app/sessionIo.ts', 'io/exporters.ts', 'convert/', 'export/'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('presentation-derived data stays out of the record', () => {
  const files = walk(SRC).filter((f) => {
    const rel = relative(SRC, f);
    return PERSISTING_SURFACE.some((s) => rel === s || rel.startsWith(s));
  });

  it('finds the persisting surface', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('never names a render-only attribute where a file is written', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const code = text.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const attr of RENDER_ONLY_ATTRIBUTES) {
        if (new RegExp(`['"\`]${attr}['"\`]`).test(code)) {
          offenders.push(`${relative(SRC, file)} → ${attr}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The estimator reads a cloud's positions and must not write them: a
  // presentation figure that altered the points it was derived from would put
  // the source wrong in the one place nobody thinks to check.
  it('derives from the source without writing to it', () => {
    const src = readFileSync(join(SRC, 'render/localDensitySize.ts'), 'utf8');
    expect(/positions\[[^\]]*\]\s*=/.test(src)).toBe(false);
    expect(src).toContain('const out = new Float32Array(n)');
  });
});
