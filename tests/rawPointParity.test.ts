import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Continuity Field may invent pixels. Measurement must never be able to
 * read one back as a measured return.
 *
 * Guarded structurally rather than numerically. Comparing measured values with
 * the field off and on would pass today for the uninteresting reason that the
 * field is off, and would keep passing until someone wired reconstruction into
 * a coordinate. Instead this asserts that nothing on the measurement path can
 * read a rendered pixel at all, which holds whatever the renderer does and
 * fails the moment a measurement module is given a way to read the screen.
 *
 * Scoped to the measurement surface on purpose. A sweep of the whole tree with
 * an allowlist would flag every legitimate image composition in the app and
 * would be widened until it meant nothing.
 */
// fileURLToPath, not URL.pathname: on Windows the latter yields `/D:/...`,
// which Node resolves against the current drive as `D:\\D:\\...`.
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Moves pixels from a rendered surface back into JavaScript. Member calls only. */
const READBACK = [
  'readRenderTargetPixels',
  'readPixels',
  'copyTextureToBuffer',
  'getImageData',
  'toDataURL',
  'toBlob',
];

/** The modules that turn a pointer or a selection into a coordinate. */
const MEASUREMENT_SURFACE = [
  'render/InspectTool.ts',
  'render/hoverPickGate.ts',
  'render/measure/',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** A member call, so a name that merely contains one of these does not match. */
const callsReadback = (text: string, api: string): boolean =>
  new RegExp(`\\.${api}\\s*\\(`).test(text);

describe('raw point parity', () => {
  const measurementFiles = walk(SRC).filter((f) =>
    MEASUREMENT_SURFACE.some((m) => relative(SRC, f).startsWith(m) || relative(SRC, f) === m),
  );

  it('finds the measurement surface', () => {
    expect(measurementFiles.length).toBeGreaterThan(5);
  });

  it('never reads a rendered pixel anywhere on the measurement path', () => {
    const offenders: string[] = [];
    for (const file of measurementFiles) {
      const text = readFileSync(file, 'utf8');
      for (const api of READBACK) {
        if (callsReadback(text, api)) offenders.push(`${relative(SRC, file)} → .${api}()`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('resolves an inspected point from stored positions', () => {
    const inspect = readFileSync(join(SRC, 'render/InspectTool.ts'), 'utf8');
    expect(inspect).toContain('positions');
  });

  // The matcher has to distinguish a call from a name that contains one. It
  // does not: `composeClassScopeBannerOntoBlob(` contains "toBlob(".
  it('matches calls, not identifiers that happen to contain one', () => {
    expect(callsReadback('await composeClassScopeBannerOntoBlob(blob, scope);', 'toBlob')).toBe(
      false,
    );
    expect(callsReadback('canvas.toBlob((b) => resolve(b));', 'toBlob')).toBe(true);
  });
});
