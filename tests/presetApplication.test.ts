/**
 * tests/presetApplication.test.ts
 *
 * What applying an inspection preset actually does to live state.
 *
 * The catalogue tests next door check the preset DATA. These check the
 * BEHAVIOUR: for every preset, that the four applied fields reach the host with
 * the values the preset declares, that the reserved fields reach nothing, that
 * the camera is never touched, that every control stays editable afterwards, and
 * that a colour mode one layer cannot render is reported as a partial
 * application rather than presented as the whole preset being active.
 *
 * The host is a recording literal rather than a DOM or renderer double: the
 * applier's only contact with the world is `PresetApplyHost`, so recording every
 * call on it records everything the applier can do.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ColorMode } from '../src/render/colorModes';
import type { ColorModeCloudFacts } from '../src/render/colorModeSupport';
import { listPresets, type SkyPreset } from '../src/render/inspectionPresets';
import { applyInspectionPreset, type PresetApplyHost } from '../src/render/presetApplication';
import type { PointSizeMode } from '../src/render/pointStyle';

/** A cloud carrying every optional attribute, so no mode is unsupported on it. */
const COMPLETE_CLOUD: ColorModeCloudFacts = {
  colors: new Uint8Array([10, 20, 30]),
  intensity: new Uint16Array([700]),
  classification: new Uint8Array([2]),
  normals: new Float32Array([0, 1, 0]),
  gpsTime: new Float64Array([3e8]),
};

/**
 * The mode every layer starts in for the per-preset sweep.
 *
 * No preset asks for `normal`, so every preset produces a real change on every
 * layer and the recorded call sequence is the same shape for all five. Starting
 * from a mode some preset happens to want would silently skip the mutation and
 * weaken the assertion for that preset only.
 */
const UNCLAIMED_MODE: ColorMode = 'normal';

interface Layer {
  mode: ColorMode;
  cloud: ColorModeCloudFacts;
}

interface StreamingSeed {
  currentMode: ColorMode;
  sourceDefaultMode: ColorMode;
}

/** Live state the host holds, so a test can read back what the applier set. */
interface LiveState {
  edlEnabled: boolean;
  edlStrength: number;
  pointSize: number;
  pointSizeMode: PointSizeMode;
  sky: SkyPreset;
  streamingMode: ColorMode | null;
}

interface Recorder {
  readonly host: PresetApplyHost;
  readonly state: LiveState;
  readonly calls: string[];
  readonly layers: Map<string, Layer>;
}

/**
 * A host that records every call and keeps the resulting state.
 *
 * The camera setters are on the stub deliberately. `PresetApplyHost` has no
 * camera member, so the applier cannot reach one — but a future edit could widen
 * the interface, and an assertion that these were never called turns that into a
 * test failure instead of a silently moving view.
 */
function recordingHost(layers: Record<string, Layer>, streaming: StreamingSeed | null): Recorder {
  const calls: string[] = [];
  const map = new Map<string, Layer>(Object.entries(layers));
  const state: LiveState = {
    edlEnabled: false,
    edlStrength: 0,
    pointSize: 0,
    pointSizeMode: 'fixed',
    sky: 'black',
    streamingMode: streaming ? streaming.currentMode : null,
  };
  const host = {
    colorHost: {
      clouds: map,
      streaming: streaming
        ? {
            get currentMode(): ColorMode {
              return state.streamingMode as ColorMode;
            },
            sourceDefaultMode: streaming.sourceDefaultMode,
            setColorMode: (m: ColorMode): void => {
              calls.push(`streaming.setColorMode:${m}`);
              state.streamingMode = m;
            },
          }
        : null,
      setCloudColorMode: (id: string, m: ColorMode): void => {
        calls.push(`setCloudColorMode:${id}:${m}`);
        const layer = map.get(id);
        if (layer) layer.mode = m;
      },
      notifyColorContextChanged: (): void => {
        calls.push('notifyColorContextChanged');
      },
    },
    setEdlEnabled: (on: boolean): void => {
      calls.push(`setEdlEnabled:${on}`);
      state.edlEnabled = on;
    },
    setEdlStrength: (s: number): void => {
      calls.push(`setEdlStrength:${s}`);
      state.edlStrength = s;
    },
    setPointSize: (px: number): void => {
      calls.push(`setPointSize:${px}`);
      state.pointSize = px;
    },
    setPointSizeMode: (m: PointSizeMode): void => {
      calls.push(`setPointSizeMode:${m}`);
      state.pointSizeMode = m;
    },
    applySky: (sky: SkyPreset): void => {
      calls.push(`applySky:${sky}`);
      state.sky = sky;
    },
    // Not part of PresetApplyHost — see the note above.
    setCameraTarget: (): void => {
      calls.push('setCameraTarget');
    },
    frameAll: (): void => {
      calls.push('frameAll');
    },
    fitToBounds: (): void => {
      calls.push('fitToBounds');
    },
  };
  return { host, state, calls, layers: map };
}

describe('applyInspectionPreset — every preset reaches live state', () => {
  for (const preset of listPresets()) {
    it(`${preset.id} sets EDL, point size, sky and colour mode to its declared values`, () => {
      // The streaming source reports the preset's own mode as the source
      // default, which is the case where it is entitled to follow.
      const r = recordingHost(
        { alpha: { mode: UNCLAIMED_MODE, cloud: COMPLETE_CLOUD } },
        { currentMode: UNCLAIMED_MODE, sourceDefaultMode: preset.defaultColorMode },
      );

      const applied = applyInspectionPreset(r.host, preset.id);

      expect(applied.presetId).toBe(preset.id);
      expect(r.state.edlEnabled).toBe(preset.edlEnabled);
      expect(r.state.edlStrength).toBe(preset.edlStrength);
      expect(r.state.pointSize).toBe(preset.pointSize);
      expect(r.state.pointSizeMode).toBe(preset.pointSizeMode);
      expect(r.state.sky).toBe(preset.sky);

      // The colour mode lands on the layer AND on the streaming source.
      expect(r.layers.get('alpha')?.mode).toBe(preset.defaultColorMode);
      expect(r.state.streamingMode).toBe(preset.defaultColorMode);
      expect(applied.colorMode.changed).toEqual(['alpha']);
      expect(applied.colorMode.unsupported).toEqual([]);
      expect(applied.colorMode.streaming).toBe('followed');
      expect(applied.partial).toBe(false);
    });

    it(`${preset.id} touches nothing else, in particular no camera control`, () => {
      const r = recordingHost(
        { alpha: { mode: UNCLAIMED_MODE, cloud: COMPLETE_CLOUD } },
        { currentMode: UNCLAIMED_MODE, sourceDefaultMode: preset.defaultColorMode },
      );

      applyInspectionPreset(r.host, preset.id);

      // The exact sequence, so an added host interaction has to be justified
      // here rather than slipping in. The reserved fields (AO strength,
      // elevation palette, hillshade) appear nowhere in it, which is the point:
      // there is no call for them to make.
      expect(r.calls).toEqual([
        `setEdlEnabled:${preset.edlEnabled}`,
        `setEdlStrength:${preset.edlStrength}`,
        `setPointSize:${preset.pointSize}`,
        `setPointSizeMode:${preset.pointSizeMode}`,
        `applySky:${preset.sky}`,
        `setCloudColorMode:alpha:${preset.defaultColorMode}`,
        `streaming.setColorMode:${preset.defaultColorMode}`,
        'notifyColorContextChanged',
      ]);
      expect(r.calls.filter((c) => /camera|frame|fit/i.test(c))).toEqual([]);
    });

    it(`${preset.id} leaves every control it set editable by hand`, () => {
      const r = recordingHost({ alpha: { mode: UNCLAIMED_MODE, cloud: COMPLETE_CLOUD } }, null);
      applyInspectionPreset(r.host, preset.id);

      // A preset is a starting point, not a lock. Overriding each knob
      // afterwards has to take effect, including back to the value the preset
      // moved away from.
      r.host.setEdlEnabled(false);
      r.host.setEdlStrength(0.11);
      r.host.setPointSize(7.5);
      r.host.setPointSizeMode(preset.pointSizeMode === 'fixed' ? 'adaptive' : 'fixed');
      r.host.applySky('studio-dark');
      r.host.colorHost.setCloudColorMode('alpha', UNCLAIMED_MODE);

      expect(r.state.edlEnabled).toBe(false);
      expect(r.state.edlStrength).toBe(0.11);
      expect(r.state.pointSize).toBe(7.5);
      expect(r.state.pointSizeMode).toBe(preset.pointSizeMode === 'fixed' ? 'adaptive' : 'fixed');
      expect(r.state.sky).toBe('studio-dark');
      expect(r.layers.get('alpha')?.mode).toBe(UNCLAIMED_MODE);
    });
  }

  it('an unknown id applies the default preset and reports which one ran', () => {
    const r = recordingHost({ alpha: { mode: UNCLAIMED_MODE, cloud: COMPLETE_CLOUD } }, null);
    const applied = applyInspectionPreset(r.host, 'not-a-preset-id');
    expect(applied.presetId).toBe('survey');
    expect(r.state.sky).toBe('survey-blue');
  });
});

/**
 * A preset naming a mode one layer cannot render is the common case, not an
 * error: an airborne strip with classification next to a photogrammetric mesh
 * cloud without it. The layer that cannot render the mode keeps the one it has,
 * and the caller has to be able to see that, or the UI will report the whole
 * preset as active while half the scene is in a different mode.
 */
describe('applyInspectionPreset — partial application is reported', () => {
  it('reports the layer that could not take the mode, and leaves it alone', () => {
    const r = recordingHost(
      {
        classified: { mode: 'rgb', cloud: { classification: new Uint8Array([2]) } },
        photogrammetric: { mode: 'rgb', cloud: { colors: new Uint8Array([1, 2, 3]) } },
      },
      null,
    );

    const applied = applyInspectionPreset(r.host, 'classification');

    expect(applied.partial).toBe(true);
    expect(applied.colorMode.changed).toEqual(['classified']);
    expect(applied.colorMode.unsupported).toEqual([{ id: 'photogrammetric', keptMode: 'rgb' }]);
    expect(r.layers.get('classified')?.mode).toBe('classification');
    expect(r.layers.get('photogrammetric')?.mode).toBe('rgb');
    // The unsupported layer was never asked to change.
    expect(r.calls).not.toContain('setCloudColorMode:photogrammetric:classification');
  });

  it('still applies every other field when the colour mode is only partly taken', () => {
    // A partial colour move must not abort the rest of the preset: EDL, point
    // size and sky have nothing to do with per-layer attributes.
    const r = recordingHost(
      { photogrammetric: { mode: 'rgb', cloud: { colors: new Uint8Array([1, 2, 3]) } } },
      null,
    );

    const applied = applyInspectionPreset(r.host, 'classification');

    expect(applied.partial).toBe(true);
    expect(applied.colorMode.changed).toEqual([]);
    expect(r.state.edlStrength).toBe(0.45);
    expect(r.state.pointSize).toBe(2.25);
    expect(r.state.sky).toBe('deep');
  });

  it('a streaming source whose tiles cannot carry the mode is a shortfall', () => {
    // The tiles carry what the format serves. A density preset over an
    // RGB-only source cannot be honoured, and saying "applied" would be false.
    const r = recordingHost({}, { currentMode: 'rgb', sourceDefaultMode: 'rgb' });

    const applied = applyInspectionPreset(r.host, 'qa');

    expect(applied.colorMode.streaming).toBe('unavailable');
    expect(applied.partial).toBe(true);
    expect(r.state.streamingMode).toBe('rgb');
    expect(r.calls).not.toContain('notifyColorContextChanged');
  });

  it('a source already in the mode, or absent, is not a shortfall', () => {
    const already = recordingHost({}, { currentMode: 'density', sourceDefaultMode: 'rgb' });
    const appliedAlready = applyInspectionPreset(already.host, 'qa');
    expect(appliedAlready.colorMode.streaming).toBe('already');
    expect(appliedAlready.partial).toBe(false);

    const none = recordingHost({}, null);
    const appliedNone = applyInspectionPreset(none.host, 'qa');
    expect(appliedNone.colorMode.streaming).toBe('none');
    expect(appliedNone.partial).toBe(false);
  });

  it('a layer already in the mode is reported as unchanged, not as a shortfall', () => {
    const r = recordingHost({ alpha: { mode: 'density', cloud: COMPLETE_CLOUD } }, null);
    const applied = applyInspectionPreset(r.host, 'qa');
    expect(applied.colorMode.unchanged).toEqual(['alpha']);
    expect(applied.colorMode.changed).toEqual([]);
    expect(applied.partial).toBe(false);
  });
});

/**
 * `Viewer.lastPresetAoStrength` was a public field assigned from
 * `preset.reserved.aoStrength` and read by nothing — no pass, no preference, no
 * panel. A public field that looks like renderer state is worse than no field:
 * the next reader assumes an AO pass consumes it. The tuned values still live in
 * `ReservedPresetCapabilities`, where the type name says they are not applied.
 *
 * This is a source-text check because `Viewer.ts` imports `three/webgpu` and
 * cannot be loaded in Node.
 */
describe('the viewer keeps no dead preset state', () => {
  const viewerSource = readFileSync(join(__dirname, '../src/render/Viewer.ts'), 'utf8');

  it('has no lastPresetAoStrength field', () => {
    expect(viewerSource).not.toMatch(/lastPresetAoStrength/);
  });

  it('reads no reserved preset capability', () => {
    // Reading `reserved` in the viewer means something is about to look
    // applied. The applier does not touch it either; see presetApplication.ts.
    expect(viewerSource).not.toMatch(/\.reserved\./);
  });
});
