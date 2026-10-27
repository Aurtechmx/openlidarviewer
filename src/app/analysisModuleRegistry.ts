/**
 * analysisModuleRegistry.ts: which analysis modules the application registers.
 *
 * Three lines in `main.ts` that name the shipped module set: the registry and
 * the two modules put into it. They moved here because the composition root is
 * shrink-only in BOTH lines and imported modules, and this block was the one
 * cluster that pays for itself: `ModuleRegistry`, `healthCheck` and
 * `scanReport` were each imported for this and nothing else, so the shell
 * gives up three module edges and takes back one.
 *
 * The registry itself stays a `main.ts` binding, because the scan-report row
 * builder reads it later. Only the construction is here, which is the part
 * that names the set.
 *
 * Adding a module is an edit to this file rather than to the shell.
 */
import { ModuleRegistry, type AnalysisRow, type RunOptions } from '../analysis/ModuleApi';
import type { PointCloud } from '../model/PointCloud';
import { healthCheck } from '../analysis/modules/healthCheck';
import { scanReport } from '../analysis/modules/scanReport';
import { storageHistoryFor } from './storageHistoryReport';

/** Read the active cloud's draw for the scan report's precision bound; lazy with the modules. */
export { drawPrecisionViewFor } from './drawPrecisionView';

/** The registry with every shipped analysis module registered, in order. */
export function createAnalysisModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(healthCheck);
  registry.register(scanReport);
  return registry;
}

let shared: ModuleRegistry | null = null;

/** One turn of the event loop: the `setTimeout(0)` yield the open path uses between its stages. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Run every registered module over a cloud and flatten the rows, in
 * registration order. The shell reaches this through `loadAnalysisModules`,
 * so the modules load with the first report rather than at startup.
 *
 * The run yields to the browser between modules, and inside a module that
 * offers `runYielding`, so a multi-million-point report is several short tasks
 * rather than one long one; the rows are the ones `run` gives. `isCurrent` is
 * asked at every yield: once it says the scan was replaced or closed, the run
 * stops and its promise never settles, so nothing paints a stale report.
 *
 * The storage-grid test runs off the main thread (`storageHistoryReport.ts`):
 * the rows returned carry its outcome when it is already known, or "test
 * running"; `onUpdate`, when given, receives the rows rebuilt with the settled
 * outcome once the test ends. Without `onUpdate` the test still runs and its
 * outcome is cached for the next call.
 */
export async function runAnalysisModules(
  cloud: PointCloud,
  options: RunOptions,
  isCurrent: () => boolean = () => true,
  yieldTask: () => Promise<void> = nextTask,
  onUpdate?: (rows: AnalysisRow[]) => void,
): Promise<AnalysisRow[]> {
  shared ??= createAnalysisModuleRegistry();
  const registry = shared;
  const storageHistory = storageHistoryFor(
    cloud,
    options.spatialContext,
    onUpdate
      ? (outcome) => {
        if (!isCurrent()) return;
        const rebuilt: AnalysisRow[] = [];
        for (const module of registry.list()) rebuilt.push(...module.run(cloud, undefined, { ...options, storageHistory: outcome }).rows);
        onUpdate(rebuilt);
      }
      : undefined,
  );
  const opts: RunOptions = { ...options, storageHistory };
  const pause = async (): Promise<boolean> => {
    await yieldTask();
    return isCurrent();
  };
  const rows: AnalysisRow[] = [];
  for (const [i, module] of registry.list().entries()) {
    if (i > 0 && !(await pause())) return new Promise<never>(() => {});
    const result = module.runYielding
      ? await module.runYielding(cloud, pause, undefined, opts)
      : module.run(cloud, undefined, opts);
    if (result === null) return new Promise<never>(() => {});
    rows.push(...result.rows);
  }
  return rows;
}
