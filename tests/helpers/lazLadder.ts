/**
 * lazLadder.ts: the PDAL-compressed size ladder the local-open benchmarks share.
 *
 * Three legs time the same files: the single reader in Node, the pooled decoder
 * in Node worker threads, and the open in a browser. They must build the same
 * cloud, compress it with the same tool and read the same environment switches,
 * or their columns are not comparable. Held here so the ladder is defined once.
 *
 * All three are gated on `LAZ_DECODE_BENCH=1` and a PDAL binary; a clone
 * without either skips cleanly.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeLas14 } from '../../src/convert/writeLas';
import type { GlobalPoints } from '../../src/convert/globalPoints';

export const LAZ_BENCH_ENABLED = process.env.LAZ_DECODE_BENCH === '1';

/** The first PDAL binary that answers `--version`, or null. */
export function pdalPath(): string | null {
  for (const p of ['/opt/homebrew/bin/pdal', '/usr/local/bin/pdal', 'pdal']) {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return p;
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** Sizes in millions of points from `LAZ_DECODE_BENCH_SIZES`, else the default. */
export function benchSizesM(defaults: string): number[] {
  return (process.env.LAZ_DECODE_BENCH_SIZES ?? defaults)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** A deterministic terrain-like cloud: a rolling surface plus small noise. */
export function makeLadderCloud(n: number): GlobalPoints {
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  let s = 20260726;
  const rnd = () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296);
  const side = Math.ceil(Math.sqrt(n));
  const span = 1000;
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / side;
    const gy = Math.floor(i / side) / side;
    x[i] = 500000 + gx * span + rnd() * 0.3;
    y[i] = 4100000 + gy * span + rnd() * 0.3;
    z[i] = 190 + 20 * Math.sin(gx * 6) * Math.cos(gy * 5) + rnd() * 0.1;
  }
  return { x, y, z, count: n } as unknown as GlobalPoints;
}

/** The origin every leg decodes against; the cloud's centre, roughly. */
export const LADDER_ORIGIN: [number, number, number] = [500000, 4100000, 190];

export interface LadderRung {
  readonly n: number;
  readonly lasPath: string;
  readonly lazPath: string;
}

/** Write the `m`-million-point rung into `dir` as LAS, then compress it with PDAL. */
export function writeLadderRung(dir: string, m: number, pdal: string): LadderRung {
  const n = Math.round(m * 1e6);
  const lasPath = join(dir, `c-${n}.las`);
  const lazPath = join(dir, `c-${n}.laz`);
  writeFileSync(lasPath, writeLas14(makeLadderCloud(n)));
  if (existsSync(lazPath)) rmSync(lazPath);
  execFileSync(pdal, ['translate', lasPath, lazPath], { stdio: 'ignore' });
  return { n, lasPath, lazPath };
}

export function removeLadderRung(rung: LadderRung): void {
  rmSync(rung.lasPath, { force: true });
  rmSync(rung.lazPath, { force: true });
}
