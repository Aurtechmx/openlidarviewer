/**
 * terrainCoreReopen.bench.ts, the browser half of the persistent-TerrainCore gate.
 *
 * The Node gate (`tests/benchmark/terrainCoreRebuildCost.test.ts`) estimates the
 * reuse side from an assumed OPFS throughput. This one measures it: in one page
 * it computes a TerrainCore fresh, serialises the grids and the scalar record,
 * writes them to a real OPFS directory with a SHA-256 integrity digest, then
 * times the whole restore path a reopen would pay: key the source (SHA-256
 * over the positions), read the bytes back, verify the digest, parse the
 * record, rebuild the typed arrays, and check the grids byte for byte against
 * the fresh core. The ratio of fresh compute to that restore is the payoff.
 *
 * GATED. Runs only under TERRAIN_CORE_OPFS_BENCH=1 (sizes via
 * TERRAIN_CORE_OPFS_BENCH_SIZES, default 100000,500000,1000000); a normal run
 * skips it. Numbers go to stdout so they survive a pass. Fresh is best-of-3
 * and first-run; restore is the median and max of 5.
 */
import { test, expect } from '@playwright/test';
import { makeTerrainBenchCloud } from '../helpers/terrainBenchCloud';

const ENABLED = process.env.TERRAIN_CORE_OPFS_BENCH === '1';
const SIZES = (process.env.TERRAIN_CORE_OPFS_BENCH_SIZES ?? '100000,500000,1000000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const print = (line: string) => process.stdout.write(line + '\n');

type Row = {
  n: number;
  cells: number;
  payloadMB: number;
  freshFirstMs: number;
  freshBestMs: number;
  keyMs: number;
  readMs: number;
  hashMs: number;
  parseMs: number;
  restoreMedianMs: number;
  restoreMaxMs: number;
  speedup: number;
  gridsIdentical: boolean;
  recordIdentical: boolean;
};

test.describe('TerrainCore restore from OPFS vs fresh compute', () => {
  test.skip(!ENABLED, 'set TERRAIN_CORE_OPFS_BENCH=1 to run');

  test('restore cost across a size ladder', async ({ page }) => {
    test.setTimeout(900_000);
    await page.goto('/');

    // The clouds are generated in Node with the gate benchmark's generator and
    // handed to the page as plain arrays; the page rebuilds the Float32Array.
    const clouds = SIZES.map((n) => ({ n, xyz: Array.from(makeTerrainBenchCloud(n)) }));
    const rows: Row[] = await page.evaluate(async (clouds: Array<{ n: number; xyz: number[] }>) => {
      const now = () => performance.now();
      const imp = (spec: string): Promise<any> => import(/* @vite-ignore */ spec);
      const [{ computeTerrainCore }, keys] = await Promise.all([
        imp('/src/terrain/contour/analyseContours.ts'),
        imp('/src/terrain/contour/persistentCoreKey.ts'),
      ]);
      const { persistentCoreKey, integrityDigest, verifyIntegrity } = keys as {
        persistentCoreKey: (p: Float32Array, params: unknown) => Promise<string>;
        integrityDigest: (b: Uint8Array) => Promise<string>;
        verifyIntegrity: (b: Uint8Array, d: string) => Promise<boolean>;
      };
      const PARAMS = { cellSizeM: 2, crs: 'EPSG:32610', verticalUnitToMetres: 1, horizontalUnitToMetres: 1 };

      // The eight grids a persisted core carries, in a fixed order, plus the
      // scalar record with those grids removed.
      const GRIDS: Array<[string, string[]]> = [
        ['z', ['dtm', 'z']], ['confidence', ['dtm', 'confidence']], ['coverage', ['dtm', 'coverage']],
        ['counts', ['dtm', 'counts']], ['interp', ['dtm', 'interpDistanceCells']],
        ['slope', ['surface', 'relief', 'slope']], ['aspect', ['surface', 'relief', 'aspect']],
        ['synth', ['surface', 'relief', 'synthesised']],
      ];
      const getPath = (o: any, p: string[]) => p.reduce((a, k) => a[k], o);
      const kindOf = (v: ArrayBufferView): string => {
        if (v instanceof Float32Array) return 'f32';
        if (v instanceof Uint32Array) return 'u32';
        if (v instanceof Uint8Array) return 'u8';
        return 'other';
      };
      const ctor: Record<string, any> = { f32: Float32Array, u32: Uint32Array, u8: Uint8Array };

      const serialise = (core: any) => {
        const record: any = JSON.parse(JSON.stringify(core, (_k, v) => (ArrayBuffer.isView(v) ? undefined : v)));
        const layout: Array<{ name: string; kind: string; bytes: number }> = [];
        let total = 0;
        for (const [name, path] of GRIDS) {
          const g = getPath(core, path) as ArrayBufferView;
          layout.push({ name, kind: kindOf(g), bytes: g.byteLength });
          total += g.byteLength;
        }
        const header = new TextEncoder().encode(JSON.stringify({ format: 1, layout, record }));
        const out = new Uint8Array(4 + header.byteLength + total);
        new DataView(out.buffer).setUint32(0, header.byteLength, true);
        out.set(header, 4);
        let o = 4 + header.byteLength;
        for (const [, path] of GRIDS) {
          const g = getPath(core, path) as ArrayBufferView;
          out.set(new Uint8Array(g.buffer, g.byteOffset, g.byteLength), o);
          o += g.byteLength;
        }
        return out;
      };
      const parse = (bytes: Uint8Array) => {
        const hlen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
        const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen)));
        const grids: Record<string, ArrayBufferView> = {};
        let o = 4 + hlen;
        for (const item of header.layout) {
          // A fresh copy, so the restored core owns its memory like a computed one.
          const src = bytes.subarray(o, o + item.bytes);
          const buf = new ArrayBuffer(item.bytes);
          new Uint8Array(buf).set(src);
          grids[item.name] = new ctor[item.kind](buf);
          o += item.bytes;
        }
        return { record: header.record, grids };
      };
      const sameBytes = (a: ArrayBufferView, b: ArrayBufferView) => {
        if (a.byteLength !== b.byteLength) return false;
        const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
        return true;
      };
      const median = (xs: number[]) => { const s = [...xs].sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };

      const root = await navigator.storage.getDirectory();
      const DIR = 'olv-terrain-core-bench';
      const out: Row[] = [];
      for (const { n, xyz } of clouds) {
        const positions = Float32Array.from(xyz);
        let freshFirst = 0, freshBest = Infinity, core: any = null;
        for (let r = 0; r < 3; r++) {
          const t0 = now();
          core = computeTerrainCore(positions, PARAMS);
          const dt = now() - t0;
          if (r === 0) freshFirst = dt;
          freshBest = Math.min(freshBest, dt);
        }
        const payload = serialise(core);
        const digest = await integrityDigest(payload);
        try { await root.removeEntry(DIR, { recursive: true }); } catch { /* first run */ }
        const dir = await root.getDirectoryHandle(DIR, { create: true });
        const fh = await dir.getFileHandle('core.bin', { create: true });
        const w = await fh.createWritable(); await w.write(payload); await w.close();
        const mh = await dir.getFileHandle('core.json', { create: true });
        const mw = await mh.createWritable(); await mw.write(JSON.stringify({ digest })); await mw.close();

        const restores: number[] = [];
        let keyMs = 0, readMs = 0, hashMs = 0, parseMs = 0, gridsIdentical = true, recordIdentical = true;
        for (let r = 0; r < 5; r++) {
          const t0 = now();
          await persistentCoreKey(positions, PARAMS);
          const t1 = now();
          const meta = JSON.parse(await (await (await dir.getFileHandle('core.json')).getFile()).text());
          const bytes = new Uint8Array(await (await (await dir.getFileHandle('core.bin')).getFile()).arrayBuffer());
          const t2 = now();
          const ok = await verifyIntegrity(bytes, meta.digest);
          const t3 = now();
          const restored = ok ? parse(bytes) : null;
          const t4 = now();
          restores.push(t4 - t0);
          keyMs += t1 - t0; readMs += t2 - t1; hashMs += t3 - t2; parseMs += t4 - t3;
          if (!restored) { gridsIdentical = false; continue; }
          for (const [name, path] of GRIDS) if (!sameBytes(restored.grids[name], getPath(core, path))) gridsIdentical = false;
          const freshRecord = JSON.stringify(core, (_k, v) => (ArrayBuffer.isView(v) ? undefined : v));
          if (JSON.stringify(restored.record) !== freshRecord) recordIdentical = false;
        }
        try { await root.removeEntry(DIR, { recursive: true }); } catch { /* best effort */ }
        const restoreMedian = median(restores);
        out.push({
          n, cells: core.dtm.cols * core.dtm.rows, payloadMB: +(payload.byteLength / 1e6).toFixed(2),
          freshFirstMs: Math.round(freshFirst), freshBestMs: Math.round(freshBest),
          keyMs: Math.round(keyMs / 5), readMs: Math.round(readMs / 5), hashMs: Math.round(hashMs / 5), parseMs: Math.round(parseMs / 5),
          restoreMedianMs: Math.round(restoreMedian), restoreMaxMs: Math.round(Math.max(...restores)),
          speedup: +(freshBest / restoreMedian).toFixed(1), gridsIdentical, recordIdentical,
        });
      }
      return out;
    }, clouds);

    print(`\nTerrainCore restore — real OPFS, Chromium, fresh best-of-3, restore median-of-5, sizes=${SIZES.join(',')}`);
    print('  points | cells | payload MB | fresh first/best ms | key | read | hash | parse | restore median/max ms | speedup | parity');
    for (const r of rows) {
      print(
        `  ${r.n.toString().padStart(8)} | ${r.cells.toString().padStart(7)} | ${r.payloadMB.toFixed(2).padStart(7)} | ` +
          `${r.freshFirstMs.toString().padStart(6)}/${r.freshBestMs.toString().padStart(6)} | ${r.keyMs.toString().padStart(4)} | ` +
          `${r.readMs.toString().padStart(4)} | ${r.hashMs.toString().padStart(4)} | ${r.parseMs.toString().padStart(4)} | ` +
          `${r.restoreMedianMs.toString().padStart(6)}/${r.restoreMaxMs.toString().padStart(6)} | ${r.speedup.toString().padStart(6)}x | ` +
          `grids ${r.gridsIdentical ? 'identical' : 'DIFFER'}, record ${r.recordIdentical ? 'identical' : 'DIFFER'}`,
      );
      expect(r.gridsIdentical, `restored grids must equal the fresh grids at ${r.n}`).toBe(true);
      expect(r.recordIdentical, `restored record must equal the fresh record at ${r.n}`).toBe(true);
    }
  });
});
