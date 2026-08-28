/**
 * openLocalHeavyLas.ts — the light decision half of the out-of-core LAS bridge.
 *
 * The whole-file loader reads a dropped LAS into one ArrayBuffer before it
 * strides it down. For an uncompressed LAS large enough to trip the memory
 * ceiling that single allocation IS the thing that fails, and the out-of-core
 * cluster exists precisely to avoid it. This module makes the DECISION to use
 * it and nothing else: the capability probe, a small header peek, and the same
 * {@link planLoad} the loader runs, through the `buildThenStream` gate. Its
 * imports are all light, so it stays in the eager shell without pulling the
 * out-of-core cluster in with it.
 *
 * The EXECUTION — the preflight, the worker build, the OPFS reopen,
 * `OlvTileSource`, the tile decoder and the streaming attach — lives in
 * `heavyLasExecutor.ts` behind `lazyChunks.loadHeavyLasExecutor`. This module
 * delegates there only after the plan has already routed the file out of core,
 * so a small LAS or LAZ never loads that chunk. For a heavy LAZ the executor
 * itself reads a bounded chunk table first and fails closed when the file cannot
 * be randomly decoded, keeping that (LAZ-only) weight out of the eager shell.
 *
 * FAIL SAFE FOR SMALL FILES, FAIL CLOSED FOR HEAVY ONES. This wires into the
 * live file-open path. Heaviness is decided FIRST, independently of capability:
 * the cheap header peek and the same {@link planLoad} the loader runs. A file
 * the plan does NOT route out of core returns `not-heavy` and the caller loads
 * it whole, exactly as before — a browser without OPFS still opens every small
 * LAS. But once a file is CONFIRMED heavy, the whole-file loader is not a safe
 * answer: its single `new Uint8Array(total)` is the very allocation that made
 * the file heavy, so for a heavy file every way the out-of-core path can decline
 * — OPFS or workers absent, the preflight refuses, the build throws — returns a
 * `heavy: true` status the caller reads as "refuse and tell the user", never
 * "fall back". Falling a heavy file through to the whole-file loader would trade
 * a clean refusal for an out-of-memory crash; that is the outcome this guards.
 */
import type { RangeSource } from '../io/range/RangeSource';
import { LocalFileRangeSource } from '../io/range/LocalFileRangeSource';
import { parseLasHeader, pointFormatHasRgb } from '../io/lasHeader';
import { decodeContext } from '../io/lasDecodeShared';
import { tileSchemaForHeader } from '../io/heavy/tileRecord';
import { sniffFormat } from '../io/sniffFormat';
import { planLoad, type PointAttributes } from '../io/loadPlan';
import { loadHeavyLasExecutor } from '../lazyChunks';
import type {
  HeavyLasBridgeDeps,
  HeavyLasBridgeEnv,
  HeavyOpenResult,
  LasHeaderFacts,
} from './heavyLasTypes';

// Re-exported so callers and tests keep one import site for the bridge's shapes.
export type {
  HeavyLasBridgeDeps,
  HeavyLasBridgeEnv,
  HeavyLasDecisionEnv,
  HeavyLasExecutorEnv,
  HeavyOpenResult,
  LasHeaderFacts,
} from './heavyLasTypes';

/**
 * The user-facing sentence for a heavy file the out-of-core path could not open.
 * Every branch names why the file could not stream AND points at the real way
 * out — converting to COPC or EPT, which stream from the file and write no local
 * cache. Never generic: the whole point of the fail-closed change is that the
 * user learns the true reason instead of watching the tab run out of memory.
 *
 * Only `unavailable`, `refused` and `failed` reach here, and only when `heavy`
 * is true; the router guarantees that before calling it.
 */
export function describeHeavyRefusal(
  result: Extract<HeavyOpenResult, { status: 'unavailable' | 'refused' | 'failed' }>,
): string {
  const convert =
    'Convert it to COPC or EPT (with PDAL or untwine) and open that instead, which streams ' +
    'from the file and writes no local cache.';
  if (result.status === 'refused') {
    // The preflight already built a precise sentence (the file name, the bytes
    // it needed against what was free, and the same convert advice); keep it.
    return result.error.message;
  }
  if (result.status === 'unavailable') {
    return (
      'This file is too large to open in one piece, and this browser has no storage for the ' +
      `streaming index (${result.reason}). ${convert}`
    );
  }
  return `This file is too large to open in one piece, and its streaming index could not be built. ${convert}`;
}

/** How many header bytes to peek. The LAS public header is 375 bytes; this is
 *  generous slack, and always far smaller than a file that routes out of core. */
const HEADER_PEEK_BYTES = 64 * 1024;

/**
 * Peek the LAS public header from a small ranged read. Both LAS and LAZ carry
 * it, so the peek serves both; the sniffed `format` is recorded so the plan and
 * the worker build route correctly. Returns null when the file is neither LAS
 * nor LAZ or the header does not parse — both of which mean the out-of-core path
 * is not ours, not that anything is wrong.
 */
async function peekLasHeaderFacts(
  range: RangeSource,
  signal: AbortSignal | undefined,
): Promise<LasHeaderFacts | null> {
  let size: number;
  try {
    size = await range.size();
  } catch {
    return null;
  }
  if (!Number.isFinite(size) || size <= 0) return null;
  let head: ArrayBuffer;
  try {
    head = await range.readRange(0, Math.min(size, HEADER_PEEK_BYTES), signal);
  } catch {
    return null;
  }
  // Both an uncompressed LAS and a compressed LAZ route here: the LAS half of
  // the tile builder reads sliced LAS, the LAZ half decodes chunk-by-chunk from
  // the LAZ chunk table. Anything else is not this path's file, so it returns
  // null and takes the whole-file loader. The LAS public header is present in
  // both, so `parseLasHeader` reads the point count and geometry either way; the
  // compression bit is masked off, so `pointFormat` is the base PDRF for LAZ too.
  const format = sniffFormat(head, range.id());
  if (format !== 'las' && format !== 'laz') return null;
  let header;
  try {
    header = parseLasHeader(head);
  } catch {
    return null;
  }
  const origin: [number, number, number] = [
    Math.floor(header.min[0]),
    Math.floor(header.min[1]),
    Math.floor(header.min[2]),
  ];
  const ctx = decodeContext(header, origin);
  const schema = tileSchemaForHeader(header.pointFormat, ctx);
  const attributes: PointAttributes = {
    hasColor: pointFormatHasRgb(header.pointFormat),
    hasIntensity: true,
    hasClassification: true,
    hasNormals: false,
    hasLasExtras: true,
  };
  return {
    format,
    declaredPointCount: header.pointCount,
    offsetToPointData: header.offsetToPointData,
    schema,
    attributes,
    fileBytes: size,
  };
}

/** The live default for the light decision seams. */
function defaultCapable(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

function defaultOpenRange(file: File): RangeSource {
  return new LocalFileRangeSource(file);
}

/**
 * Attempt to open `file` through the out-of-core build. See the module header
 * for the contract: a `not-heavy` result is the caller's cue to load the file
 * whole; a `heavy: true` `unavailable` / `refused` / `failed` is its cue to
 * refuse and surface the message; `attached` / `cancelled` are terminal.
 */
export async function openLocalHeavyLas(
  file: File,
  signal: AbortSignal,
  deps: HeavyLasBridgeDeps,
  env: Partial<HeavyLasBridgeEnv> = {},
): Promise<HeavyOpenResult> {
  const capable = env.capable ?? defaultCapable;
  const openRange = env.openRange ?? defaultOpenRange;

  // Heaviness FIRST, before the capability probe. The header peek is a small
  // ranged read that is cheap even where the out-of-core path cannot run, and it
  // is what tells us whether a fall-through to the whole-file loader is safe. A
  // file whose header does not parse as a LAS or LAZ is not one this path
  // handles, so it is not-heavy and the whole-file loader takes it.
  const facts = await peekLasHeaderFacts(openRange(file), signal);
  if (facts === null) return { status: 'not-heavy' };

  // The same plan the whole-file loader computes, acted on before a point is
  // decoded. `buildThenStream` is set for a LAS or LAZ whose whole-file estimate
  // exceeds the memory ceiling, from the same ceiling for both formats.
  const plan = planLoad({
    sourceCount: facts.declaredPointCount,
    fileBytes: facts.fileBytes,
    budget: deps.renderBudget,
    isMobile: deps.isPhone(),
    deviceMemoryGB: deps.deviceMemoryGB(),
    attributes: facts.attributes,
    format: facts.format,
  });
  if (!plan.buildThenStream) return { status: 'not-heavy' };

  // The file is CONFIRMED heavy from here on. Now the capability probe: without
  // OPFS and workers the out-of-core path cannot run, and the whole-file loader
  // is NOT a safe fall-back for a heavy file — it faces the same too-large
  // allocation. So this refuses (`heavy: true`) rather than falling through. In
  // a Node/JSDOM harness neither Worker nor OPFS exists, but a test injects
  // `env.capable`, so this branch is exercised deliberately, not by the harness.
  if (!capable()) {
    return { status: 'unavailable', heavy: true, reason: 'OPFS or Web Workers unavailable' };
  }

  // With the file confirmed heavy and the platform capable, load the out-of-core
  // execution chunk. The decision path above never triggers this import, so the
  // eager shell never pays for the cluster. Every non-`attached`/`cancelled`
  // result it returns is a confirmed-heavy failure the caller must surface.
  const { executeHeavyLasBuild } = await loadHeavyLasExecutor();
  return executeHeavyLasBuild(file, signal, facts, deps, env);
}
