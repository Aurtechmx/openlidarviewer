/**
 * AppRuntime.ts — the application's composition root.
 *
 * One `AppRuntime` is created at boot. It owns the shared {@link AppContext}
 * and, as the v0.6 decomposition proceeds, the extracted services (dataset,
 * layer, session, …). main.ts constructs it once and reads shared state through
 * `runtime.context` rather than from module-level mutables, so a service can be
 * carved out by moving a function body behind a stable seam without re-plumbing
 * the state it touches.
 */

import { createAppContext, type AppContext } from './appContext';

/** The composition root: shared state now, extracted services as they land. */
export interface AppRuntime {
  readonly context: AppContext;
}

/** Construct the runtime with a fresh, empty AppContext. */
export function createAppRuntime(): AppRuntime {
  return { context: createAppContext() };
}
