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

/** The registry with every shipped analysis module registered, in order. */
export function createAnalysisModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(healthCheck);
  registry.register(scanReport);
  return registry;
}

let shared: ModuleRegistry | null = null;

/**
 * Run every registered module over a cloud and flatten the rows, in
 * registration order. The shell reaches this through `loadAnalysisModules`,
 * so the modules load with the first report rather than at startup.
 */
export function runAnalysisModules(cloud: PointCloud, options: RunOptions): AnalysisRow[] {
  shared ??= createAnalysisModuleRegistry();
  const rows: AnalysisRow[] = [];
  for (const module of shared.list()) rows.push(...module.run(cloud, undefined, options).rows);
  return rows;
}
