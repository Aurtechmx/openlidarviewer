/**
 * The real action registry assembled over inert fakes, for the tests that
 * read its ids, titles and keys without running anything.
 */
import { vi } from 'vitest';
import { buildActionRegistry, type ActionRegistryDeps } from '../../src/app/actionDefinitions';
import type { Action } from '../../src/ui/actionRegistry';

export function buildTestActionRegistry(): Action[] {
  const noop = vi.fn();
  return buildActionRegistry({
    getViewer: () => ({}) as never, getTour: () => null, workflowController: { capture: noop } as never, lassoVolumeTool: {} as never,
    compass: {} as never, bookmarks: {} as never, showLassoToast: noop, setTheme: noop, syncLassoButton: noop,
    runDeriveClassification: async () => undefined, saveSnapshot: noop, copyShareLink: noop, terrainAnalysisEntry: {} as never,
    runFillUnclassified: async () => undefined, buildCurrentStoryInputs: () => ({}) as never, startWorkflowRecording: noop,
    dispatchWorkflowEvent: noop, ensureWorkflowConfigPanel: async () => ({}) as never, ensureShortcutSheet: async () => ({}) as never,
    hasScan: () => false, saveCurrentView: noop, applyView: noop, toggleOrbitInvert: noop, resetNavigation: noop,
    planView: { togglePlanView: noop, notePlanViewPreset: noop },
  } as unknown as ActionRegistryDeps);
}
