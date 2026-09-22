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
import { ModuleRegistry } from '../analysis/ModuleApi';
import { healthCheck } from '../analysis/modules/healthCheck';
import { scanReport } from '../analysis/modules/scanReport';

/** The registry with every shipped analysis module registered, in order. */
export function createAnalysisModuleRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry();
  registry.register(healthCheck);
  registry.register(scanReport);
  return registry;
}
