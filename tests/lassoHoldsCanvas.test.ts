/**
 * lassoHoldsCanvas.test.ts
 *
 * A lasso must not keep the canvas after another tool starts, and while one is
 * armed the pill says so. Reclassify ends with its page.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { installLiveFakeDom } from './helpers/liveFakeDom';
import { readActiveTool, type ActiveToolViewer } from '../src/app/activeToolStatus';
import { Viewer } from '../src/render/Viewer';
import { disarmReclassifyOffPage, toolModeChanged } from '../src/ui/LassoVolumeTool';
import { contributeToolActions } from '../src/app/actions/toolActions';

beforeAll(installLiveFakeDom);

function fakeViewer(mode: string) {
  const active = () => ({ setActive: vi.fn(), setNavigationPaused: vi.fn() });
  const listeners = () => ({ onModeChange: vi.fn() });
  return {
    _toolMode: mode, _toolPaused: false, _measure: active(), _inspect: active(), _annotate: active(), _probe: active(),
    _demand: { changed: vi.fn() }, _canvas: { style: {} }, _nav: { setInputEnabled: vi.fn() },
    _measureListeners: listeners(), _inspectListeners: listeners(), _annotateListeners: listeners(), _probeListeners: listeners(),
    onToolModeChange: vi.fn(),
    _setToolMode: (Viewer.prototype as never as Record<string, (m: string) => void>)._setToolMode,
  };
}

describe('Viewer lasso mode', () => {
  const setLasso = Viewer.prototype.setLassoMode;
  it('setLassoMode(false) leaves a newly chosen tool on', () => {
    const v = fakeViewer('measure');
    setLasso.call(v as never, false);
    expect(v._toolMode).toBe('measure');
  });
  it('setLassoMode(false) ends lasso mode', () => {
    const v = fakeViewer('lasso');
    setLasso.call(v as never, false);
    expect(v._toolMode).toBe('none');
  });
  it('reports the mode change with the mode it left', () => {
    const v = fakeViewer('lasso');
    v._setToolMode('probe');
    expect(v.onToolModeChange).toHaveBeenCalledWith('lasso', 'probe');
  });
});

describe('toolModeChanged', () => {
  const make = () => ({ disarmVolume: vi.fn(), disarmReclassify: vi.fn() });
  it.each(['measure', 'inspect', 'annotate', 'probe'])('%s disarms both lassos', (next) => {
    const d = make();
    toolModeChanged('lasso', next, d);
    expect(d.disarmVolume).toHaveBeenCalledTimes(1);
    expect(d.disarmReclassify).toHaveBeenCalledTimes(1);
  });
  it('arming the volume lasso ends reclassify but not itself', () => {
    const d = make();
    toolModeChanged('none', 'lasso', d);
    expect(d.disarmVolume).not.toHaveBeenCalled();
    expect(d.disarmReclassify).toHaveBeenCalledTimes(1);
  });
  it('going to no tool disarms nothing here', () => {
    const d = make();
    toolModeChanged('lasso', 'none', d);
    expect(d.disarmVolume).not.toHaveBeenCalled();
    expect(d.disarmReclassify).not.toHaveBeenCalled();
  });
});

describe('palette lasso', () => {
  it('moves the viewer into lasso mode like the other routes', () => {
    const setLassoMode = vi.fn();
    const tool = { enabled: false, enable() { this.enabled = true; }, disable() { this.enabled = false; } };
    const actions = contributeToolActions({ getViewer: () => ({ setLassoMode, clearSelectionHighlight: vi.fn() }) as never, workflowController: {} as never, lassoVolumeTool: tool as never, syncLassoButton: vi.fn(), runDeriveClassification: vi.fn(), runFillUnclassified: vi.fn(), showLassoToast: vi.fn(), runTool: vi.fn() } as never);
    const lasso = actions.find((a) => a.id === 'tool.lasso-volume')!;
    lasso.run();
    expect(setLassoMode).toHaveBeenLastCalledWith(true);
    lasso.run();
    expect(setLassoMode).toHaveBeenLastCalledWith(false);
  });
});

describe('active-tool pill', () => {
  const viewer = { measureMode: true, inspectMode: false, annotateMode: false, measure: { kind: 'distance', firstVertexForClose: () => null, finishCurrent: vi.fn() }, setMeasureMode: vi.fn(), setInspectMode: vi.fn(), setAnnotateMode: vi.fn() } as ActiveToolViewer;
  it('shows an armed lasso ahead of measure mode, and Cancel disarms it', () => {
    const cancel = vi.fn();
    const snap = readActiveTool({ viewer, clipEnabled: false, lasso: { key: 'lasso', label: 'Lasso volume: draw a shape', cancel } });
    expect(snap.mode?.label).toBe('Lasso volume: draw a shape');
    snap.mode?.cancel();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(viewer.setMeasureMode).not.toHaveBeenCalled();
  });
  it('reads the tool as before with nothing armed', () => {
    expect(readActiveTool({ viewer, clipEnabled: false, lasso: null }).mode?.label).toBe('Measuring distance');
  });
});

describe('reclassify leaves with its page', () => {
  it('disarms and says so when the Classes page is left', () => {
    const toast = vi.fn();
    disarmReclassifyOffPage({ mode: 'analyse', page: null }, { disarm: () => true }, toast);
    expect(toast).toHaveBeenCalledWith('Reclassify lasso off.');
  });
  it('is quiet on the Classes page and when not armed', () => {
    const toast = vi.fn();
    const disarm = vi.fn(() => false);
    disarmReclassifyOffPage({ mode: 'data', page: 'classes' }, { disarm }, toast);
    expect(disarm).not.toHaveBeenCalled();
    disarmReclassifyOffPage({ mode: 'data', page: null }, { disarm }, toast);
    expect(toast).not.toHaveBeenCalled();
  });
});
