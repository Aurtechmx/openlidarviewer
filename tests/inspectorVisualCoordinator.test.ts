/**
 * inspectorVisualCoordinator.test.ts
 *
 * Viewer visual state projected into the Inspector over fake ports: the
 * workflow rail reads the preset the knobs equal or 'custom', the advanced
 * white-balance disclosure follows streaming, a preset fans out through the
 * setters and re-projects every touched surface, unknown ids are ignored, and
 * the streaming filter seed moves UNSEEDED to SEEDED exactly once until reset.
 * The sink and view are spies; the source is a mutable record. Setters write
 * back into that record, so a preset's effect is observable through the same
 * reads the projection uses. No Viewer, no DOM. The colour-mode record is a
 * plain field. Preference persistence is a spy the cases count.
 */
import { describe, it, expect, vi } from 'vitest';
import { createInspectorVisualCoordinator } from '../src/app/inspectorVisualCoordinator';
import { getTerrainWorkflowPreset, TERRAIN_WORKFLOW_PRESET_ORDER } from '../src/render/terrainWorkflowPresets';

function harness() {
  const state = {
    edlPresetId: 'off' as string | null,
    pointSize: 2,
    pointSizeMode: 'fixed' as string,
    skyPresetId: 'deep-navy',
    heightPercentileTrim: 0,
    rgbAppearancePresetId: 'neutral',
    rgbAppearance: { temperature: 0.2, tint: -0.1 } as { temperature?: number; tint?: number },
    streamingActive: false,
    edlEnabled: false,
    edlStrength: 1,
    antialiasing: 'off',
    twoFingerTwistEnabled: true,
    splatMode: 'points',
    hasStreamingCloud: false,
    elevationExtent: null as [number, number] | null,
    intensityExtent: null as [number, number] | null,
    colorMode: 'elevation' as string | undefined,
  };
  const source = Object.fromEntries(Object.keys(state).map((k) => [k, () => (state as never)[k]])) as never;
  const sink = {
    setEdlPreset: vi.fn((id: string | null) => { state.edlPresetId = id; }),
    setPointSize: vi.fn((v: number) => { state.pointSize = v; }),
    setPointSizeMode: vi.fn((m: string) => { state.pointSizeMode = m; }),
    setSky: vi.fn((id: string) => { state.skyPresetId = id; }),
    setHeightPercentileTrim: vi.fn((t: number) => { state.heightPercentileTrim = t; }),
    applyRgbAppearancePreset: vi.fn(),
    setRgbAppearance: vi.fn((a: { temperature?: number; tint?: number }) => { state.rgbAppearance = a; }),
    setColorMode: vi.fn(),
    setStreamingColorMode: vi.fn(),
  };
  const view = {
    syncVisuals: vi.fn(), setAdvancedWbVisible: vi.fn(), syncRendering: vi.fn(),
    setElevationExtent: vi.fn(), setIntensityExtent: vi.fn(),
  };
  const after = vi.fn();
  const prefs = vi.fn();
  const warn = vi.fn();
  const c = createInspectorVisualCoordinator({
    source, sink: sink as never, view: view as never,
    activeScanId: () => 'scan-1',
    colorMode: { get: () => state.colorMode as never, set: (m) => { state.colorMode = m; } },
    afterColorModeChange: after,
    onPreferenceChanged: prefs,
    warn,
  });
  return { c, state, sink, view, after, prefs, warn };
}

describe('inspector visual coordinator', () => {
  it('reads custom when no preset matches, and the preset id when one does', () => {
    const h = harness();
    h.c.syncVisuals();
    expect(h.view.syncVisuals.mock.calls[0][0].workflowPresetId).toBe('custom');
    const id = TERRAIN_WORKFLOW_PRESET_ORDER[0];
    const p = getTerrainWorkflowPreset(id);
    Object.assign(h.state, {
      colorMode: p.colorMode, edlPresetId: p.edlPresetId, pointSize: p.pointSize,
      pointSizeMode: p.pointSizeMode, skyPresetId: p.sky, heightPercentileTrim: p.heightPercentileTrim,
    });
    h.c.syncVisuals();
    expect(h.view.syncVisuals.mock.calls[1][0].workflowPresetId).toBe(id);
  });

  it('projects white balance with zero defaults and the streaming disclosure', () => {
    const h = harness();
    h.state.rgbAppearance = {};
    h.c.syncVisuals();
    const s = h.view.syncVisuals.mock.calls[0][0];
    expect(s.temperature).toBe(0);
    expect(s.tint).toBe(0);
    expect(h.view.setAdvancedWbVisible).toHaveBeenLastCalledWith(false);
    h.state.streamingActive = true;
    h.c.syncVisuals();
    expect(h.view.setAdvancedWbVisible).toHaveBeenLastCalledWith(true);
  });

  it('a workflow preset fans out through the setters and re-projects everything', () => {
    const h = harness();
    const id = TERRAIN_WORKFLOW_PRESET_ORDER[0];
    const p = getTerrainWorkflowPreset(id);
    h.c.applyWorkflowPreset(id);
    expect(h.sink.setEdlPreset).toHaveBeenCalledWith(p.edlPresetId);
    expect(h.sink.setPointSize).toHaveBeenCalledWith(p.pointSize);
    expect(h.sink.setSky).toHaveBeenCalledWith(p.sky);
    expect(h.sink.setColorMode).toHaveBeenCalledWith('scan-1', p.colorMode);
    expect(h.state.colorMode).toBe(p.colorMode);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.view.syncVisuals).toHaveBeenCalledTimes(1);
    expect(h.view.syncRendering).toHaveBeenCalledTimes(1);
    expect(h.prefs).toHaveBeenCalledTimes(1);
    expect(h.view.syncVisuals.mock.calls[0][0].workflowPresetId).toBe(id);
  });

  it('a channel-less cloud keeps its colours and the rest of the bundle lands', () => {
    const h = harness();
    h.sink.setColorMode.mockImplementation(() => { throw new Error('no rgb channel'); });
    const id = TERRAIN_WORKFLOW_PRESET_ORDER[0];
    h.c.applyWorkflowPreset(id);
    expect(h.state.colorMode).toBe('elevation');
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.sink.setSky).toHaveBeenCalled();
    expect(h.prefs).toHaveBeenCalledTimes(1);
  });

  it('unknown rgb and sky ids are ignored, known ones apply and persist', () => {
    const h = harness();
    h.c.applyRgbAppearancePreset('not-a-preset');
    h.c.applySky('not-a-sky');
    expect(h.sink.applyRgbAppearancePreset).not.toHaveBeenCalled();
    expect(h.sink.setSky).not.toHaveBeenCalled();
    expect(h.prefs).not.toHaveBeenCalled();
    h.c.applyRgbAppearancePreset('natural');
    expect(h.sink.applyRgbAppearancePreset).toHaveBeenCalledWith('natural');
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.prefs).toHaveBeenCalledTimes(1);
  });

  it('white balance keeps the other appearance fields and re-syncs the chip', () => {
    const h = harness();
    h.state.rgbAppearance = { temperature: 0, tint: 0, ...( { gamma: 1.2 } as object) };
    h.c.setWhiteBalance(0.5, -0.3);
    expect(h.sink.setRgbAppearance).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.5, tint: -0.3, gamma: 1.2 }));
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.prefs).toHaveBeenCalledTimes(1);
  });

  it('the streaming filter seed moves to seeded once and resets on lifecycle', () => {
    const h = harness();
    expect(h.c.seedStreamingFilterExtents()).toBe(false); // no streaming cloud
    h.state.hasStreamingCloud = true;
    expect(h.c.seedStreamingFilterExtents()).toBe(false); // nothing resident yet
    expect(h.c.streamingFilterSeed()).toBe('unseeded');
    h.state.elevationExtent = [10, 20];
    expect(h.c.seedStreamingFilterExtents()).toBe(true);
    expect(h.c.streamingFilterSeed()).toBe('seeded');
    expect(h.view.setElevationExtent).toHaveBeenCalledWith([10, 20]);
    expect(h.view.setIntensityExtent).toHaveBeenCalledWith(null);
    h.state.intensityExtent = [0, 255];
    expect(h.c.seedStreamingFilterExtents()).toBe(true); // already seeded: no re-seed
    expect(h.view.setIntensityExtent).toHaveBeenCalledTimes(1);
    h.c.resetStreamingFilterSeed();
    expect(h.c.streamingFilterSeed()).toBe('unseeded');
    expect(h.c.seedStreamingFilterExtents()).toBe(true);
    expect(h.view.setIntensityExtent).toHaveBeenLastCalledWith([0, 255]);
  });

  it('rendering projection carries every knob', () => {
    const h = harness();
    h.c.syncRendering();
    expect(h.view.syncRendering).toHaveBeenCalledWith({
      pointSize: 2, edlEnabled: false, edlStrength: 1, pointSizeMode: 'fixed',
      antialiasing: 'off', twoFingerTwistEnabled: true, splatMode: 'points',
    });
  });
});
