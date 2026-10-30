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
    runDeriveClassification: () => Promise.resolve(undefined), saveSnapshot: noop, copyShareLink: noop, terrainAnalysisEntry: {} as never,
    runFillUnclassified: () => Promise.resolve(undefined), runTool: noop, buildCurrentStoryInputs: () => ({}) as never, startWorkflowRecording: noop,
    dispatchWorkflowEvent: noop, ensureWorkflowConfigPanel: () => Promise.resolve({} as never), ensureShortcutSheet: () => Promise.resolve({} as never),
    hasScan: () => false, saveCurrentView: noop, applyView: noop, toggleOrbitInvert: noop, resetNavigation: noop, toggleReferencePlane: noop,
    planView: { togglePlanView: noop, notePlanViewPreset: noop, toggleNavigationPanel: noop, showStandardView: noop, setOrthographic: noop, frameAll: noop },
  } as unknown as ActionRegistryDeps);
}
