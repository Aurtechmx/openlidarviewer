/**
 * actionDefinitions.ts
 *
 * The command-palette / shortcut-sheet action registry: one assembler over the
 * contributors in `src/app/actions/`, each of which receives only the shell
 * collaborators its own actions use. Nothing here has behaviour of its own.
 * The shell builds the registry on the first surface that needs it (palette,
 * sheet, a Dataset Story click), so none of this rides the startup chunk.
 *
 * Two collaborators are read through getters: `viewer` is a `let` assigned
 * after boot, and `tour` starts null and is set later. Both resolve when a
 * handler fires, not when the registry is built.
 */
import type { Action } from '../ui/actionRegistry';
import type { Viewer } from '../render/Viewer';
import type { TourHandle } from '../ui/onboarding/bootTour';
import type { WorkflowController } from '../ui/WorkflowController';
import type { WorkflowConfigPanel } from '../ui/WorkflowConfigPanel';
import type { WorkflowEvent } from '../render/workflow/workflowRecorder';
import type { ShortcutSheet } from '../ui/ShortcutSheet';
import type { LassoVolumeTool } from '../ui/LassoVolumeTool';
import type { CompassController } from '../ui/compassController';
import type { ViewBookmarksService } from './viewBookmarks';
import type { ThemeName } from '../ui/themes';
import type { TerrainAnalysisEntryDeps } from './openTerrainAnalysis';
import type { ScanStoryInputs } from '../intelligence/scanStory';
import { contributeCameraActions, type PlanViewActions } from './actions/cameraActions';
import { contributeViewActions } from './actions/viewActions';
import { contributeToolActions } from './actions/toolActions';
import { contributeAnalysisActions } from './actions/analysisActions';
import { contributeExportActions } from './actions/exportActions';
import { contributeWorkflowActions } from './actions/workflowActions';
import { contributeHelpActions } from './actions/helpActions';

export type { PlanViewActions } from './actions/cameraActions';

export interface ActionRegistryDeps {
  getViewer: () => Viewer;
  getTour: () => TourHandle | null;
  workflowController: WorkflowController;
  lassoVolumeTool: LassoVolumeTool;
  compass: CompassController;
  bookmarks: ViewBookmarksService;
  showLassoToast: (
    message: string,
    action?: { readonly label: string; readonly onClick: () => void },
  ) => void;
  setTheme: (name: ThemeName) => void;
  syncLassoButton: () => void;
  runDeriveClassification: () => Promise<void>;
  saveSnapshot: () => void | Promise<void>;
  copyShareLink: () => void | Promise<void>;
  terrainAnalysisEntry: TerrainAnalysisEntryDeps;
  runFillUnclassified: () => Promise<void>;
  buildCurrentStoryInputs: () => ScanStoryInputs;
  startWorkflowRecording: () => void;
  dispatchWorkflowEvent: (event: WorkflowEvent) => void;
  ensureWorkflowConfigPanel: () => Promise<WorkflowConfigPanel>;
  ensureShortcutSheet: () => Promise<ShortcutSheet>;
  hasScan: () => boolean;
  saveCurrentView: () => void;
  applyView: (index: number) => void;
  toggleOrbitInvert: (axis: 'x' | 'y') => void;
  resetNavigation: () => void;
  planView: PlanViewActions;
}

/** Assemble the registry in its display order: camera, theme and view, tools, analyse, export, workflow, help. */
export function buildActionRegistry(deps: ActionRegistryDeps): Action[] {
  const capture: WorkflowController['capture'] = (event) => deps.workflowController.capture(event);
  const camera = contributeCameraActions({
    getViewer: deps.getViewer,
    planView: deps.planView,
    capture,
    showLassoToast: deps.showLassoToast,
  });
  const view = contributeViewActions({
    setTheme: deps.setTheme,
    capture,
    compass: deps.compass,
    bookmarks: deps.bookmarks,
    toggleOrbitInvert: deps.toggleOrbitInvert,
    resetNavigation: deps.resetNavigation,
    hasScan: deps.hasScan,
    saveCurrentView: deps.saveCurrentView,
    applyView: deps.applyView,
    showLassoToast: deps.showLassoToast,
  });
  const tools = contributeToolActions({
    getViewer: deps.getViewer,
    workflowController: deps.workflowController,
    lassoVolumeTool: deps.lassoVolumeTool,
    syncLassoButton: deps.syncLassoButton,
    runDeriveClassification: deps.runDeriveClassification,
    runFillUnclassified: deps.runFillUnclassified,
    showLassoToast: deps.showLassoToast,
  });
  const analysis = contributeAnalysisActions({
    terrainAnalysisEntry: deps.terrainAnalysisEntry,
    buildCurrentStoryInputs: deps.buildCurrentStoryInputs,
  });
  const exports_ = contributeExportActions({
    saveSnapshot: deps.saveSnapshot,
    copyShareLink: deps.copyShareLink,
    buildCurrentStoryInputs: deps.buildCurrentStoryInputs,
  });
  const workflow = contributeWorkflowActions({
    workflowController: deps.workflowController,
    startWorkflowRecording: deps.startWorkflowRecording,
    dispatchWorkflowEvent: deps.dispatchWorkflowEvent,
    ensureWorkflowConfigPanel: deps.ensureWorkflowConfigPanel,
    showLassoToast: deps.showLassoToast,
  });
  const help = contributeHelpActions({
    getTour: deps.getTour,
    ensureShortcutSheet: deps.ensureShortcutSheet,
  });
  // The theme rows sit between the camera rows and the tools, as before.
  const theme = view.filter((a) => a.section === 'Theme');
  const rest = view.filter((a) => a.section !== 'Theme');
  return [...camera, ...theme, ...tools, ...analysis, ...exports_, ...workflow, ...rest, ...help];
}
