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
 * so a small LAS, any LAZ, or a non-capable environment never loads that chunk.
 *
 * FAIL SAFE, ALWAYS. This wires into the live file-open path, so it must never
 * make a working open worse. Every way the out-of-core path can decline — the
 * plan says no, OPFS or workers are absent, the preflight refuses, the build or
 * the attach throws before the commit — returns a status the caller reads as
 * "fall back to the whole-file loader". A crash or a blank scene where the file
 * used to open is the one outcome this function exists to prevent.
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

/** How many header bytes to peek. The LAS public header is 375 bytes; this is
 *  generous slack, and always far smaller than a file that routes out of core. */
const HEADER_PEEK_BYTES = 64 * 1024;

/**
 * Peek the LAS header from a small ranged read. Returns null when the file is
 * not an uncompressed LAS or the header does not parse — both of which mean the
 * out-of-core path is not ours, not that anything is wrong.
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
  // Only an UNCOMPRESSED LAS routes here: the tile builder reads sliced LAS, and
  // a LAZ stays on the whole-file strided path until the chunked-LAZ builder is
  // wired. `sniffFormat` distinguishes the two before the header is trusted.
  if (sniffFormat(head, range.id()) !== 'las') return null;
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
  return { declaredPointCount: header.pointCount, schema, attributes, fileBytes: size };
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
 * for the fail-safe contract: any non-`attached` result is the caller's cue to
 * fall back to the whole-file loader (or, for `refused`, to surface the message).
 */
export async function openLocalHeavyLas(
  file: File,
  signal: AbortSignal,
  deps: HeavyLasBridgeDeps,
  env: Partial<HeavyLasBridgeEnv> = {},
): Promise<HeavyOpenResult> {
  const capable = env.capable ?? defaultCapable;
  const openRange = env.openRange ?? defaultOpenRange;

  // Capability probe first, before any read: without OPFS and workers the
  // out-of-core path cannot run, and the whole-file loader is the answer. In a
  // Node/JSDOM harness neither exists, so this returns immediately and the live
  // open path behaves exactly as it did before this module.
  if (!capable()) return { status: 'unavailable', reason: 'OPFS or Web Workers unavailable' };

  const facts = await peekLasHeaderFacts(openRange(file), signal);
  if (facts === null) return { status: 'not-heavy' };

  // The same plan the whole-file loader computes, acted on before a point is
  // decoded. `buildThenStream` is set only for an uncompressed LAS whose
  // whole-file estimate exceeds the memory ceiling.
  const plan = planLoad({
    sourceCount: facts.declaredPointCount,
    fileBytes: facts.fileBytes,
    budget: deps.renderBudget,
    isMobile: deps.isPhone(),
    deviceMemoryGB: deps.deviceMemoryGB(),
    attributes: facts.attributes,
    format: 'las',
  });
  if (!plan.buildThenStream) return { status: 'not-heavy' };

  // Only now, with the file confirmed heavy, load the out-of-core execution
  // chunk. The decision path above never triggers this import, so the eager
  // shell never pays for the cluster.
  const { executeHeavyLasBuild } = await loadHeavyLasExecutor();
  return executeHeavyLasBuild(file, signal, facts, deps, env);
}
