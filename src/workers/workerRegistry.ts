/**
 * src/workers/workerRegistry.ts
 *
 * Single source of truth for every Web Worker the app ships.
 *
 * Background — the #266 production crash. `vite.config.ts` used to hand-maintain
 * TWO parallel lists about workers: the live-transform `exclude` patterns and
 * the chunk-emission pin list. A worker added to the codebase but missed from
 * either list shipped a chunk that 404s at runtime: the live transform scrambled
 * the `new Worker(new URL(...))` specifier, the chunk never emitted, and the
 * dynamic import surfaced as `vite:preloadError` and a forced full reload.
 *
 * The fix declares every worker once, here. `vite.config.ts` derives BOTH lists
 * from this registry, so no worker name is copied by hand into two places, and a
 * completeness test (tests/workerRegistry.test.ts) fails the suite if a worker
 * module exists under `src/` but is absent from this registry.
 *
 * Adding a worker: append one entry below. The obfuscation exclude, the
 * chunk-emission pins, and the build-guard chunk assertion all follow from it.
 *
 * Fields:
 *   - id                 stable key for the worker.
 *   - workerModule       the worker source, reached via `new Worker(new URL())`.
 *   - workerChunk        the emitted chunk basename (Rollup names the split
 *                        chunk after the module basename). The build guard
 *                        asserts a chunk whose name contains this string emits.
 *   - clientModule       the module holding the `new Worker(new URL(...))`
 *                        literal. It must be excluded from the live transform:
 *                        the stringArray pass would scramble the specifier.
 *   - asyncBridgeModule  optional module holding `import('./<client>')`. Present
 *                        when the client is reached through a lazy import; it
 *                        must be excluded from the live transform too, or the
 *                        import literal scrambles and the client chunk 404s.
 *   - pinClientChunk     true when the client arrives through a dynamic import
 *                        (via asyncBridgeModule) rather than a static import, so
 *                        its own chunk must be pinned by the build guard.
 */

export interface WorkerDeclaration {
  readonly id: string;
  readonly workerModule: string;
  readonly workerChunk: string;
  readonly clientModule: string;
  readonly asyncBridgeModule?: string;
  readonly pinClientChunk?: boolean;
}

export const WORKER_REGISTRY: readonly WorkerDeclaration[] = [
  {
    id: 'parse',
    workerModule: 'src/io/parseWorker.ts',
    workerChunk: 'parseWorker',
    clientModule: 'src/io/loadFile.ts',
  },
  {
    id: 'copc',
    workerModule: 'src/io/copc/worker/copcWorker.ts',
    workerChunk: 'copcWorker',
    clientModule: 'src/io/copc/worker/copcWorkerClient.ts',
  },
  {
    id: 'eptLaszip',
    workerModule: 'src/io/ept/worker/eptLaszipWorker.ts',
    workerChunk: 'eptLaszipWorker',
    clientModule: 'src/io/ept/worker/eptLaszipWorkerClient.ts',
  },
  {
    id: 'terrainCore',
    workerModule: 'src/terrain/worker/terrainCoreWorker.ts',
    workerChunk: 'terrainCoreWorker',
    clientModule: 'src/terrain/worker/terrainCoreWorkerClient.ts',
    asyncBridgeModule: 'src/terrain/worker/computeTerrainCoreAsync.ts',
    pinClientChunk: true,
  },
  {
    id: 'deriveClassification',
    workerModule: 'src/render/class/deriveClassificationWorker.ts',
    workerChunk: 'deriveClassificationWorker',
    clientModule: 'src/render/class/deriveClassificationWorkerClient.ts',
    asyncBridgeModule: 'src/render/class/deriveClassificationAsync.ts',
    pinClientChunk: true,
  },
  {
    id: 'lazChunk',
    workerModule: 'src/io/heavy/worker/lazChunkWorker.ts',
    workerChunk: 'lazChunkWorker',
    clientModule: 'src/io/heavy/worker/lazChunkWorkerClient.ts',
    asyncBridgeModule: 'src/io/loadLas.ts',
    pinClientChunk: true,
  },
  {
    id: 'localOocIndexer',
    workerModule: 'src/io/heavy/worker/localOocIndexerWorker.ts',
    workerChunk: 'localOocIndexerWorker',
    clientModule: 'src/io/heavy/worker/localOocIndexerWorkerClient.ts',
  },
] as const;

/** Escape a string for safe embedding inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The basename (with extension) of a `src/...` module path. */
function basename(path: string): string {
  return path.split('/').pop() as string;
}

/**
 * Modules that must be excluded from the live source transform because they
 * carry a worker specifier the stringArray pass would scramble: each worker's
 * client module (`new Worker(new URL(...))`) and its async bridge, if any.
 *
 * Worker MODULES themselves are not listed: they build in Vite's separate,
 * un-transformed worker pass, so the transform never touches them.
 */
export function workerExcludeModules(): string[] {
  const modules: string[] = [];
  for (const w of WORKER_REGISTRY) {
    modules.push(w.clientModule);
    if (w.asyncBridgeModule) modules.push(w.asyncBridgeModule);
  }
  return modules;
}

/** `RegExp` patterns for {@link workerExcludeModules}, matched against module ids. */
export function workerExcludePatterns(): RegExp[] {
  return workerExcludeModules().map((m) => new RegExp(escapeRegExp(basename(m))));
}

/**
 * Chunk-name substrings the build guard must find in the emitted bundle: every
 * worker chunk, plus the client chunk of any worker whose client arrives through
 * a dynamic import (those cannot be covered by lazyChunks.ts).
 */
export function workerChunkPins(): string[] {
  const pins: string[] = [];
  for (const w of WORKER_REGISTRY) {
    pins.push(w.workerChunk);
    if (w.pinClientChunk) pins.push(basename(w.clientModule).replace(/\.ts$/, ''));
  }
  return pins;
}
