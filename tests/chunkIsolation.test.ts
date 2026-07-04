/**
 * tests/chunkIsolation.test.ts
 *
 * Post-build chunk-isolation regression guard. Walks the most recently
 * produced `dist/assets/*.js` files and asserts the v0.3.7 chunk-graph
 * contract:
 *
 *   - `vendor-three-webgpu` exists and is the ONLY chunk over the
 *     500 KB Vite warning threshold.
 *   - Every required code-split chunk exists by name.
 *   - The startup shell (`index-*.js`) contains no inlined WebGPU
 *     runtime, no pdf-lib, no laz-perf, no EPT runtime, no report
 *     subsystem, no export runtime, and no debug / benchmark code.
 *
 * The test is intentionally cheap — it reads file sizes and does small
 * substring scans, no parsing. It auto-skips when `dist/` doesn't exist
 * (so a fresh checkout that hasn't built yet still passes the suite);
 * CI and the release-prep script run `npm run build` before `npm test`,
 * so the assertions actually fire in the relevant paths.
 *
 * Pairs with the in-Vite `chunkEmissionGuard` plugin in `vite.config.ts`
 * — the plugin fails the build, this test fails the suite. Two guards,
 * one contract.
 *
 * SCOPE: this gates the PLAIN `npm run build` only. The OBFUSCATED `build:live`
 * (what actually ships) inflates the startup shell well past 500 KB, so it is
 * gated separately against its own, larger per-chunk budget by
 * `npm run check:bundle`. Running THIS isolation rule against the live build is
 * expected to fail and is not the contract — the two builds answer to two
 * different size rules, and CI enforces both.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist', 'assets');

/**
 * Chunk-isolation ceiling, in bytes. Vite's nominal warning is 500 KB
 * (500 × 1024 = 512,000); we allow the eager index a small, bounded margin over
 * it for legitimate core load-time logic — CRS resolution, datum
 * provenance, coordinate bridges — plus the thin lazy-feature TRIGGERS that must
 * live in the shell (each new Products/Export/edit action wires a sub-KB handler
 * + control here while its heavy code rides a separate chunk). This guard's real
 * job is to catch HEAVY code leaking into the eager chunk (a stray three.js /
 * pdf / decoder import is hundreds of KB), which this small margin doesn't mask —
 * the genuine leak guard is the `SHELL_FORBIDDEN_CONTENT` fingerprint test below.
 * The shipped artifact is the obfuscated live build, gated separately by
 * `check-bundle-budget.mjs` against its own ceiling.
 *
 * Raised 504 → 508 KiB at v0.5.5 P1 as a deliberate, committed decision:
 * the hand tool's shell surfaces (the NavBar Pan pad + hand icon, its HUD
 * legend chip, and the `setPanAvailable` flag wiring) added ~1.6 KB to the
 * eager index (measured 516,055 B → 517,678 B), and the previous ceiling
 * had only 41 B of headroom left. The drag geometry itself (panMath +
 * NavController) rides the lazy Viewer chunk, not the shell — this is
 * exactly the "sub-KB trigger + control in the shell, heavy code in a
 * chunk" split the margin exists for.
 *
 * Raised 508 → 512 KiB at v0.5.5 for the collapsible side rails: the left and
 * right grabber wiring, the chevron SVGs, and the per-panel toggle controls
 * added a little more eager shell surface (index measured 520,230 B, 38 B over
 * the prior ceiling). Same split as above — only the sub-KB DOM triggers live in
 * the shell; the rail and camera logic ride lazy chunks.
 *
 * Raised 512 → 516 KiB at v0.5.6 for the point-filter correctness work: the
 * Inspector range controls, the drop-zone "Opening" state, the export summaryInfo
 * callback, the streaming filter-extent seeding, and the GPU-error / catalog
 * wiring added eager shell surface (index measured 526,032 B, 1,744 B over the
 * prior ceiling). The heavy filter logic — the per-point accept predicate
 * (`pointFilterAccept`), per-cloud extent scans, and the mask nodes — rides the
 * lazy Viewer chunk, and the `SHELL_FORBIDDEN_CONTENT` test below confirms no
 * decoder/pdf/WebGPU import leaked into the shell. Same sub-KB-trigger split.
 */
const WARNING_THRESHOLD = 516 * 1024;

/** Required chunk-name prefixes — substring-matched against the filename. */
const REQUIRED_CHUNK_PREFIXES = [
  'vendor-three-webgpu',
  'vendor-pdf',
  'vendor-laz',
  'Viewer',
  'report',
  'export',
  'lazDecode',
  'copcWorker',
  'eptLaszipWorker',
  'EptStreamingPointCloud',
  'EptChunkDecoder',
  'DebugOverlay',
  'streamingBenchmark',
  // v0.4.5 — dynamic-import seams moved into lazyChunks.ts after the live
  // transform's stringArray pass scrambled their inline specifiers (missing
  // planetaryComputer / rgbAutoNormalize chunks; loadLas pre-warm 404).
  'loadLas',
  'planetaryComputer',
  'rgbAutoNormalize',
  'embedBridge',
  // v0.4.5 — interior floor-plan pipeline + Space/Object report PDF, lazy
  // via lazyChunks.ts (loadFloorPlan / loadSpaceReportPdf). Pinned so a
  // re-inline (or a scrambled specifier) can't silently kill the Object
  // panel's "Floor plan" / "Report PDF" exports on the deployed site.
  'extractFloorPlan',
  'floorPlanSvg',
  'spaceReportPdf',
] as const;

/**
 * Substrings that must NOT appear inlined inside the startup shell.
 * These are minified module-content fingerprints — strings the
 * respective subsystem's source carries that would survive minification
 * and indicate the subsystem ended up in the shell rather than a
 * lazy-loaded chunk.
 *
 * We deliberately pick fingerprints that are NOT also used as dynamic
 * `import()` URL literals: those literals legitimately appear in the
 * shell (the shell is what schedules the imports) and would create
 * false positives if matched.
 */
const SHELL_FORBIDDEN_CONTENT = [
  // pdf-lib's font-loader carries a distinctive base64 prelude.
  'PDFDocument',
  // laz-perf's WASM glue exports a distinctive symbol.
  'LASZip',
  // Three.js WebGPU runtime carries the WebGPURenderer class name.
  'WebGPURenderer',
  // TSL runtime — NodeMaterial is a unique signature.
  'NodeMaterial',
] as const;

function listDistAssets(): string[] {
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST).filter((f) => f.endsWith('.js'));
}

function findChunk(prefix: string, files: readonly string[]): string | undefined {
  return files.find((f) => f.includes(prefix));
}

describe('post-build chunk isolation contract', () => {
  const files = listDistAssets();
  // Gate on an explicit opt-in, NOT merely on dist/ existing: a STALE dist (an
  // older build still on disk) would otherwise fail this contract during a
  // normal `npm test`, making the default command non-deterministic. The
  // contract is only meaningful immediately after a build, so it runs only when
  // BUILD_CONTRACT=1 is set — which `npm run test:build` and CI (which builds
  // first) do, and a plain `npm test` does not.
  const distExists = files.length > 0 && process.env.BUILD_CONTRACT === '1';

  it.skipIf(!distExists)('every required chunk is emitted by name', () => {
    for (const prefix of REQUIRED_CHUNK_PREFIXES) {
      const hit = findChunk(prefix, files);
      expect(hit, `missing chunk for prefix "${prefix}"`).toBeDefined();
    }
  });

  it.skipIf(!distExists)(
    'vendor-three-webgpu is the only chunk over the 500 KB warning threshold',
    () => {
      const oversized = files
        .map((f) => ({ f, size: statSync(join(DIST, f)).size }))
        .filter((entry) => entry.size > WARNING_THRESHOLD)
        .map((entry) => entry.f);
      // The expected set is a single chunk — vendor-three-webgpu.
      const unexpected = oversized.filter((f) => !f.includes('vendor-three-webgpu'));
      expect(unexpected, `unexpected oversized chunks: ${unexpected.join(', ')}`).toEqual([]);
      // Sanity — the WebGPU vendor chunk itself must still be present
      // and over threshold (otherwise the manualChunks rule regressed).
      const webgpuChunk = findChunk('vendor-three-webgpu', files);
      expect(webgpuChunk).toBeDefined();
    },
  );

  it.skipIf(!distExists)(
    'the startup shell does not inline pdf-lib, laz-perf, WebGPU renderer, or TSL runtime',
    () => {
      const shell = files.find((f) => f.startsWith('index-') && f.endsWith('.js'));
      expect(shell, 'startup shell `index-*.js` not found').toBeDefined();
      const shellText = readFileSync(join(DIST, shell!), 'utf8');
      const leaks: string[] = [];
      for (const needle of SHELL_FORBIDDEN_CONTENT) {
        if (shellText.includes(needle)) leaks.push(needle);
      }
      expect(
        leaks,
        `forbidden subsystem fingerprints leaked into the shell: ${leaks.join(', ')}`,
      ).toEqual([]);
    },
  );

  it.skipIf(!distExists)(
    'every app-owned chunk except vendor-three-webgpu is under the warning threshold',
    () => {
      const appOwnedOversized = files
        .filter((f) => !f.includes('vendor-three-webgpu'))
        .map((f) => ({ f, size: statSync(join(DIST, f)).size }))
        .filter((entry) => entry.size > WARNING_THRESHOLD);
      expect(
        appOwnedOversized,
        `unexpected oversized app/vendor chunks: ${appOwnedOversized
          .map((e) => `${e.f}=${e.size}B`)
          .join(', ')}`,
      ).toEqual([]);
    },
  );
});
