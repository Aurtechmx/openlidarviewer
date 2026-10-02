import type { Page } from '@playwright/test';
import type { GlobalPoints } from '../../src/convert/globalPoints';

/**
 * Synthetic LAS scans with known geometry, built by the app's own LAS writer.
 *
 * - `geom-a`: a 40 x 30 m grid at E 500000, N 4000000, ground at Z 100, with a
 *   0.5 m pit, so its floor(min) origin is (500000, 4000000, 99).
 * - `geom-b`: a 10 x 10 m plane 100 m east of A at Z 50 (2,601 points).
 * - `geom-nocrs`: geom-a written with no CRS records.
 * - `broken`: geom-b cut to its first 400 bytes, so the header declares 2,601
 *   points and the body holds 4.
 *
 * The writer reads the Vite-defined `__BUILD_IDENTITY__` at module load, so it
 * is imported after the global is stubbed.
 */
async function writer(): Promise<typeof import('../../src/convert/writeLas').writeLas> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test',
    commit: 'unknown',
    dirty: false,
    builtAt: '1970-01-01T00:00:00.000Z',
  };
  return (await import('../../src/convert/writeLas')).writeLas;
}

const E0 = 500000;
const N0 = 4000000;
const Z0 = 100;
const S = 0.2;

function grid(nx: number, ny: number, dx: number, z: (x: number, y: number) => number): GlobalPoints {
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = +(i * S).toFixed(3);
      const y = +(j * S).toFixed(3);
      xs.push(E0 + dx + x);
      ys.push(N0 + y);
      zs.push(Z0 + z(x, y));
    }
  }
  return { count: xs.length, x: Float64Array.from(xs), y: Float64Array.from(ys), z: Float64Array.from(zs) };
}

const pit = (x: number, y: number): number => (x >= 32 && x <= 35 && y >= 4 && y <= 7 ? -0.5 : 0);
const UTM13N = { epsg: 32613, isGeographic: false, linearUnitCode: 9001 } as const;

export async function geomFixtures(): Promise<Record<'geomA' | 'geomB' | 'geomNoCrs' | 'broken', Uint8Array>> {
  const writeLas = await writer();
  const a = grid(200, 150, 0, pit);
  const b = grid(50, 50, 100, () => -50);
  return {
    geomA: writeLas(a, UTM13N),
    geomB: writeLas(b, UTM13N),
    geomNoCrs: writeLas(a, {}),
    broken: writeLas(b, { epsg: 32613 }).slice(0, 400),
  };
}

/** Drop bytes on the page as a file named `name`. */
export async function dropBytes(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const dt = await page.evaluateHandle(
    ({ b, n }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(b)], n));
      return d;
    },
    { b: [...bytes], n: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}
