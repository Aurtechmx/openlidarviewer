import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadLas } from '../src/io/loadLas';
import { LoadError } from '../src/io/loadErrors';

function fixture(name: string): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
}

/** Overwrite three bytes of the point-data region, chosen deterministically from `seed`. */
function mutate(base: ArrayBuffer, seed: number): ArrayBuffer {
  const out = base.slice(0);
  const u = new Uint8Array(out);
  let s = (seed * 2654435761) >>> 0;
  for (let k = 0; k < 3; k++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const pos = 400 + (s % (u.length - 400));
    s = (s * 1103515245 + 12345) >>> 0;
    u[pos] = s & 255;
  }
  return out;
}

describe('LAZ decode of a corrupt stream', () => {
  test('every failure is a categorised LoadError, never a raw Emscripten string', async () => {
    const base = fixture('tiny-pdrf1.laz');
    let failures = 0;
    for (let seed = 0; seed < 150; seed++) {
      try {
        await loadLas(mutate(base, seed), 'laz', 'x.laz', 1);
      } catch (e) {
        failures++;
        expect(e).toBeInstanceOf(Error);
        expect(e).toBeInstanceOf(LoadError);
        expect((e as LoadError).category).toBe('malformed-file');
        // The message is ours, not an Emscripten address-and-text string, and
        // the raw value that was thrown stays reachable as the cause.
        expect((e as LoadError).message).toMatch(/^malformed LAZ: decompression failed/);
        expect((e as LoadError).message).not.toMatch(/Exception catching|^\d+\b/);
        const cause = (e as LoadError).cause;
        expect(typeof cause === 'string' || typeof cause === 'number' || cause instanceof WebAssembly.RuntimeError).toBe(true);
      }
    }
    // The mutations must actually break some streams, or the loop proves nothing.
    expect(failures).toBeGreaterThan(0);
  });

  test('an unmutated file still decodes', async () => {
    const pc = await loadLas(fixture('tiny-pdrf1.laz'), 'laz', 'x.laz', 1);
    expect(pc.pointCount).toBeGreaterThan(0);
  });
});
