/**
 * noScanPress.test.ts
 *
 * With no scan open a command that needs one says so instead of arming over the
 * empty state, doing nothing, or reporting success.
 */
import { describe, it, expect, vi } from 'vitest';
import { contributeToolActions } from '../src/app/actions/toolActions';
import { contributeCameraActions } from '../src/app/actions/cameraActions';
import { contributeAnalysisActions } from '../src/app/actions/analysisActions';
import { contributeExportActions } from '../src/app/actions/exportActions';
import { contributeViewActions } from '../src/app/actions/viewActions';
import { loggedAction } from '../src/app/actionDefinitions';
import { sessionSaveRefusal, snapshotRefusal } from '../src/app/pendingSessionRestore';

const REASON = 'Open a scan first.';
function live(scan: { open: boolean }) {
  const hasScan = () => scan.open;
  const tools = contributeToolActions({ getViewer: () => ({}) as never, workflowController: {} as never, lassoVolumeTool: {} as never, syncLassoButton: vi.fn(), runDeriveClassification: vi.fn(), runFillUnclassified: vi.fn(), showLassoToast: vi.fn(), runTool: vi.fn(), hasScan } as never);
  const camera = contributeCameraActions({ getViewer: () => ({}) as never, planView: {} as never, capture: vi.fn(), showLassoToast: vi.fn(), hasScan } as never);
  const analysis = contributeAnalysisActions({ terrainAnalysisEntry: {} as never, observatoryEntry: {} as never, buildCurrentStoryInputs: vi.fn(), showLassoToast: { show: vi.fn() }, hasScan } as never);
  const toast = vi.fn();
  const build = vi.fn();
  const exports_ = contributeExportActions({ saveSnapshot: vi.fn(), copyShareLink: vi.fn(), exportSession: vi.fn(), handleFile: vi.fn(), openScan: vi.fn(), exportReport: vi.fn(), buildCurrentStoryInputs: build, showLassoToast: toast, hasScan } as never);
  return { all: [...tools, ...camera, ...analysis, ...exports_].map(loggedAction), toast, build };
}
const NEEDS_SCAN = ['tool.measure', 'tool.inspect', 'tool.annotate', 'tool.clip', 'tool.lasso-volume', 'camera.top', 'camera.iso', 'camera.oblique', 'camera.planar', 'camera.plan-view', 'camera.view-front', 'camera.frame-all', 'analyse.run', 'analyse.contours', 'tool.snapshot'];

describe('palette rows that need a scan', () => {
  it.each(NEEDS_SCAN)('%s is unavailable with no scan and live again with one', (id) => {
    const scan = { open: false };
    const a = live(scan).all.find((x) => x.id === id)!;
    expect(a.unavailable).toBe(REASON);
    scan.open = true;
    expect(a.unavailable).toBeUndefined();
  });
});

describe('Export health check with no scan', () => {
  it('says so and never builds a Ready verdict from empty inputs', () => {
    const { all, toast, build } = live({ open: false });
    all.find((a) => a.id === 'export.health')!.run();
    expect(toast).toHaveBeenCalledWith('No scan open. Open a scan to check it.');
    expect(build).not.toHaveBeenCalled();
  });
});

describe('Toggle compass with no scan', () => {
  it('says the new state, since nothing shows until a scan opens', () => {
    const toast = vi.fn();
    let on = true;
    const actions = contributeViewActions({ setTheme: vi.fn(), capture: vi.fn(), compass: { isEnabled: () => on, setEnabled: (v: boolean) => { on = v; } }, bookmarks: { savedViews: [] }, toggleOrbitInvert: vi.fn(), resetNavigation: vi.fn(), toggleReferencePlane: vi.fn(), showTouchGestures: vi.fn(), hasScan: () => false, saveCurrentView: vi.fn(), applyView: vi.fn(), showLassoToast: toast } as never);
    actions.find((a) => a.id === 'view.compass')!.run();
    expect(toast).toHaveBeenCalledWith('Compass off. It shows when a scan is open.');
  });
});

describe('saves with nothing open', () => {
  it('a session refuses only when it would hold nothing', () => {
    const empty = { hasScan: false, heldWork: false, savedViews: 0 };
    expect(sessionSaveRefusal(empty)).toBe('Open a scan first. A session records work on an open scan.');
    expect(sessionSaveRefusal({ ...empty, hasScan: true })).toBeNull();
    expect(sessionSaveRefusal({ ...empty, heldWork: true })).toBeNull();
    expect(sessionSaveRefusal({ ...empty, savedViews: 2 })).toBeNull();
  });
  it('a snapshot refuses with no scan', () => {
    expect(snapshotRefusal(false)).toBe('Open a scan first, then save a snapshot.');
    expect(snapshotRefusal(true)).toBeNull();
  });
});
