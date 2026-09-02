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
import { createLayerIdentityService, type LayerIdentityService } from './layerIdentityService';
import { createStreamingClassLedger, type StreamingClassLedger } from './streamingClassLedger';

/** The composition root: shared state now, extracted services as they land. */
export interface AppRuntime {
  readonly context: AppContext;
  /**
   * The one owner of layer identity for this session (audit item O). Binds each
   * loaded cloud to a stable, name-independent id and decides the owner stamped
   * on new work. Held here so it is constructed once, alongside the shared
   * state, rather than as a module-level singleton in the shell.
   */
  readonly layerIdentity: LayerIdentityService;
  /**
   * The session tally of classification counts over the UNIQUE streamed nodes
   * decoded so far. DISPLAY ONLY — it feeds the class legend and nothing
   * scientific. Held here so the shell keeps exactly one per session and can
   * reset it from every path that changes the streaming dataset.
   */
  readonly streamingClasses: StreamingClassLedger;
}

/** Construct the runtime with a fresh, empty AppContext and its services. */
export function createAppRuntime(): AppRuntime {
  return {
    context: createAppContext(),
    layerIdentity: createLayerIdentityService(),
    streamingClasses: createStreamingClassLedger(),
  };
}
