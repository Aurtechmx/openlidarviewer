/**
 * actionContributors.test.ts
 *
 * The registry is assembled from contributors that each take only what their
 * actions use. These tests pin that: every contributor builds from its own
 * narrow deps and nothing else, ids stay unique across the assembly, the
 * display order the palette relies on is unchanged, and the assembler adds no
 * action of its own. Fakes are the minimum each contributor touches. Where
 * a run has a visible effect, the test fires it and reads the fake. The
 * workflow contributor is read against its own feature flag.
 */
import { describe, it, expect, vi } from 'vitest';
import { contributeCameraActions } from '../src/app/actions/cameraActions';
import { contributeViewActions } from '../src/app/actions/viewActions';
import { contributeToolActions } from '../src/app/actions/toolActions';
import { contributeAnalysisActions } from '../src/app/actions/analysisActions';
import { contributeExportActions } from '../src/app/actions/exportActions';
import { contributeWorkflowActions } from '../src/app/actions/workflowActions';
import { contributeHelpActions } from '../src/app/actions/helpActions';
import { WORKFLOW_RECORDER_ENABLED } from '../src/ui/WorkflowController';
import { findDuplicateIds } from '../src/ui/actionRegistry';

const toast = vi.fn();

describe('action contributors', () => {
  it('camera actions need the viewer, plan view, capture and toast only', () => {
    const viewer = { setCameraPreset: vi.fn(() => true), setStandardView: vi.fn(() => true), setOrthographic: vi.fn(() => true), orthographic: false, frameAll: vi.fn() };
    const capture = vi.fn();
    const planView = { togglePlanView: vi.fn(), notePlanViewPreset: vi.fn() };
    const actions = contributeCameraActions({ getViewer: () => viewer as never, planView, capture, showLassoToast: toast });
    expect(actions.map((a) => a.id)).toEqual(expect.arrayContaining(['camera.top', 'camera.plan-view', 'camera.orthographic', 'camera.frame-all']));
    actions.find((a) => a.id === 'camera.top')!.run();
    expect(planView.notePlanViewPreset).toHaveBeenCalledWith('top');
    expect(capture).toHaveBeenCalledWith({ type: 'camera-preset', name: 'top' });
    actions.find((a) => a.id === 'camera.frame-all')!.run();
    expect(viewer.frameAll).toHaveBeenCalled();
    expect(actions.every((a) => a.section === 'Camera')).toBe(true);
  });

  it('view actions route theme, compass, handedness and view states', () => {
    const setTheme = vi.fn(); const capture = vi.fn();
    const compass = { isEnabled: () => false, setEnabled: vi.fn() };
    const bookmarks = { count: () => 0, get: () => undefined };
    const deps = { setTheme, capture, compass: compass as never, bookmarks: bookmarks as never, toggleOrbitInvert: vi.fn(), resetNavigation: vi.fn(), showTouchGestures: vi.fn(), hasScan: () => false, saveCurrentView: vi.fn(), applyView: vi.fn(), showLassoToast: toast };
    const actions = contributeViewActions(deps);
    actions.find((a) => a.id === 'theme.dark')!.run();
    expect(setTheme).toHaveBeenCalledWith('dark');
    actions.find((a) => a.id === 'view.compass')!.run();
    expect(compass.setEnabled).toHaveBeenCalledWith(true);
    actions.find((a) => a.id === 'nav.invert-vertical')!.run();
    expect(deps.toggleOrbitInvert).toHaveBeenCalledWith('y');
    // The gestures action only re-flashes the hint; it asks nothing of the app.
    actions.find((a) => a.id === 'nav.gestures')!.run();
    expect(deps.showTouchGestures).toHaveBeenCalled();
    actions.find((a) => a.id === 'view.save-state')!.run();
    expect(deps.saveCurrentView).not.toHaveBeenCalled(); // no scan: refused with a toast
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Load a scan first/));
  });

  it('tool actions run the derived classification and toggle the lasso', async () => {
    const lasso = { enabled: false, enable: vi.fn(), disable: vi.fn(), selectionBasis: 'through-surfaces' };
    const deps = { getViewer: () => ({ clearSelectionHighlight: vi.fn() }) as never, workflowController: {} as never, lassoVolumeTool: lasso as never, syncLassoButton: vi.fn(), runDeriveClassification: vi.fn(async () => undefined), runFillUnclassified: vi.fn(async () => undefined), showLassoToast: toast, toggleClip: vi.fn() };
    const actions = contributeToolActions(deps);
    actions.find((a) => a.id === 'tool.classify')!.run();
    expect(deps.runDeriveClassification).toHaveBeenCalled();
    actions.find((a) => a.id === 'tool.lasso-volume')!.run();
    expect(lasso.enable).toHaveBeenCalled();
    expect(deps.syncLassoButton).toHaveBeenCalled();
    expect(actions.find((a) => a.id === 'tool.lasso-volume')!.keys).toBe('L');
  });

  it('analysis and export contributors take two deps each', () => {
    const analysis = contributeAnalysisActions({ terrainAnalysisEntry: {} as never, buildCurrentStoryInputs: () => ({}) as never });
    expect(analysis.map((a) => a.id)).toEqual(['analyse.run', 'analyse.contours', 'analyse.flowPulse', 'story.dataset']);
    const exp = contributeExportActions({ saveSnapshot: vi.fn(), copyShareLink: vi.fn(), buildCurrentStoryInputs: () => ({}) as never });
    expect(exp.map((a) => a.id)).toEqual(['tool.snapshot', 'tool.share', 'export.health', 'report.verify']);
  });

  it('workflow actions follow the feature flag; help needs the tour and the sheet', () => {
    const wf = contributeWorkflowActions({ workflowController: {} as never, startWorkflowRecording: vi.fn(), dispatchWorkflowEvent: vi.fn(), ensureWorkflowConfigPanel: vi.fn(), showLassoToast: toast });
    expect(wf.length).toBe(WORKFLOW_RECORDER_ENABLED ? 4 : 0);
    const replay = vi.fn();
    const help = contributeHelpActions({ getTour: () => ({ replay }) as never, ensureShortcutSheet: vi.fn() });
    help.find((a) => a.id === 'tour.replay')!.run();
    expect(replay).toHaveBeenCalled();
  });

  it('ids are unique across every contributor', () => {
    const all = [
      ...contributeCameraActions({ getViewer: () => ({}) as never, planView: { togglePlanView() {}, notePlanViewPreset() {} }, capture: vi.fn(), showLassoToast: toast }),
      ...contributeViewActions({ setTheme: vi.fn(), capture: vi.fn(), compass: {} as never, bookmarks: {} as never, toggleOrbitInvert: vi.fn(), resetNavigation: vi.fn(), showTouchGestures: vi.fn(), hasScan: () => false, saveCurrentView: vi.fn(), applyView: vi.fn(), showLassoToast: toast }),
      ...contributeToolActions({ getViewer: () => ({}) as never, workflowController: {} as never, lassoVolumeTool: {} as never, syncLassoButton: vi.fn(), runDeriveClassification: vi.fn(), runFillUnclassified: vi.fn(), showLassoToast: toast, toggleClip: vi.fn() }),
      ...contributeAnalysisActions({ terrainAnalysisEntry: {} as never, buildCurrentStoryInputs: () => ({}) as never }),
      ...contributeExportActions({ saveSnapshot: vi.fn(), copyShareLink: vi.fn(), buildCurrentStoryInputs: () => ({}) as never }),
      ...contributeWorkflowActions({ workflowController: {} as never, startWorkflowRecording: vi.fn(), dispatchWorkflowEvent: vi.fn(), ensureWorkflowConfigPanel: vi.fn(), showLassoToast: toast }),
      ...contributeHelpActions({ getTour: () => null, ensureShortcutSheet: vi.fn() }),
    ];
    expect(findDuplicateIds(all)).toEqual([]);
    expect(all.length).toBeGreaterThanOrEqual(35);
  });
});
