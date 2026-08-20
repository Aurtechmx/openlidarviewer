/**
 * speedQualityPolicy.test.ts
 *
 * The Speed ↔ Quality master control's policy layer: the pure position →
 * settings map, the automatic position, the pixel-ratio ceiling it writes, the
 * apply adapter, and the preference parser.
 *
 * Two properties carry the whole feature and are pinned hardest here:
 *
 *   1. MONOTONICITY. Every field must be non-decreasing from the Speed end to
 *      the Quality end, on every device. A slider whose middle is slower than
 *      its left end would be worse than no slider.
 *   2. SCOPE. The resolved settings must contain display and streaming fields
 *      ONLY. The static load budget (`deviceCaps().renderBudget`) reduces the
 *      decoded cloud that terrain analysis, measurement and export all read, so
 *      it must never appear here — the surface is asserted field by field so a
 *      future edit cannot slip a computed-quantity knob in unnoticed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  QUALITY_MAX,
  QUALITY_MIN,
  QUALITY_STOPS,
  autoQualityPosition,
  clampQualityPosition,
  midQualityPosition,
  qualityLabelFor,
  qualityPolicyIsMonotonic,
  qualitySettingsFor,
  qualityStepFor,
  resolveQualitySettings,
  type QualityDevice,
} from '../src/render/quality/qualityPolicy';
import {
  MAX_PIXEL_RATIO_DEFAULT,
  MAX_PIXEL_RATIO_MAX,
  MAX_PIXEL_RATIO_MIN,
  clampPixelRatioCeiling,
  maxPixelRatio,
  resetMaxPixelRatio,
  setMaxPixelRatio,
} from '../src/render/quality/pixelRatioCeiling';
import {
  applyQualitySettings,
  type QualityRenderHost,
} from '../src/render/quality/applyQualitySettings';
import { streamingBudgets, type StreamingQuality } from '../src/render/streaming/streamingBudget';
import {
  DEFAULT_QUALITY_PREFERENCE,
  parseQualityPreference,
} from '../src/ui/qualityPreferenceStore';

/** A capable WebGPU desktop — the reference device for most assertions. */
const DESKTOP: QualityDevice = { tier: 'high', isMobile: false, backend: 'webgpu' };
/** The same desktop on the WebGL 2 fallback, where EDL defaults off. */
const DESKTOP_GL: QualityDevice = { tier: 'high', isMobile: false, backend: 'webgl2' };
/** A capable phone. */
const PHONE: QualityDevice = { tier: 'medium', isMobile: true, backend: 'webgpu' };
/** A weak machine — the tier the shell used to degrade by hand. */
const WEAK: QualityDevice = { tier: 'low', isMobile: false, backend: 'webgpu' };

const ALL_DEVICES: readonly QualityDevice[] = [DESKTOP, DESKTOP_GL, PHONE, WEAK];

/** Every field a resolved settings object is allowed to carry. */
const SETTINGS_FIELDS = [
  'antialiasing',
  'edlEnabled',
  'maxConcurrentDecodes',
  'maxPixelRatio',
  'position',
  'streamingPointBudget',
  'streamingQuality',
];

afterEach(() => {
  // The ceiling is module state the apply path writes; leaving it moved would
  // leak into the next test in this file.
  resetMaxPixelRatio();
});

describe('quality policy — bounds', () => {
  it('runs 0 to 100 with the midpoint at 50', () => {
    expect(QUALITY_MIN).toBe(0);
    expect(QUALITY_MAX).toBe(100);
    expect(midQualityPosition()).toBe(50);
  });

  it('clamps anything outside the range, and falls back to the midpoint on a non-number', () => {
    expect(clampQualityPosition(-40)).toBe(QUALITY_MIN);
    expect(clampQualityPosition(1e6)).toBe(QUALITY_MAX);
    expect(clampQualityPosition(Number.NaN)).toBe(midQualityPosition());
    expect(clampQualityPosition(Number.POSITIVE_INFINITY)).toBe(midQualityPosition());
  });

  it('puts the ends on the first and last stop, and never past them', () => {
    expect(qualityStepFor(QUALITY_MIN)).toBe(0);
    expect(qualityStepFor(QUALITY_MAX)).toBe(QUALITY_STOPS.length - 1);
    expect(qualityStepFor(-999)).toBe(0);
    expect(qualityStepFor(999)).toBe(QUALITY_STOPS.length - 1);
  });

  it('labels the ends and the midpoint', () => {
    expect(qualityLabelFor(QUALITY_MIN)).toBe('Speed');
    expect(qualityLabelFor(midQualityPosition())).toBe('Balanced');
    expect(qualityLabelFor(QUALITY_MAX)).toBe('Quality');
  });
});

describe('quality policy — the three positions the control exposes', () => {
  it('the Speed end is the cheapest frame the viewer can draw', () => {
    const settings = qualitySettingsFor(QUALITY_MIN, DESKTOP);
    expect(settings.position).toBe(QUALITY_MIN);
    expect(settings.streamingQuality).toBe('low');
    expect(settings.maxPixelRatio).toBe(MAX_PIXEL_RATIO_MIN);
    expect(settings.edlEnabled).toBe(false);
    expect(settings.antialiasing).toBe(false);
  });

  it('the midpoint reproduces the shipping defaults', () => {
    const settings = qualitySettingsFor(midQualityPosition(), DESKTOP);
    expect(settings.streamingQuality).toBe('balanced');
    expect(settings.maxPixelRatio).toBe(MAX_PIXEL_RATIO_DEFAULT);
    expect(settings.antialiasing).toBe(true);
  });

  it('the Quality end is the densest frame the viewer can draw', () => {
    const settings = qualitySettingsFor(QUALITY_MAX, DESKTOP);
    expect(settings.position).toBe(QUALITY_MAX);
    expect(settings.streamingQuality).toBe('high');
    expect(settings.maxPixelRatio).toBe(MAX_PIXEL_RATIO_MAX);
    expect(settings.edlEnabled).toBe(true);
    expect(settings.antialiasing).toBe(true);
  });

  it('reads the streaming budgets off the existing table rather than restating them', () => {
    for (const device of ALL_DEVICES) {
      for (const position of [QUALITY_MIN, midQualityPosition(), QUALITY_MAX]) {
        const settings = qualitySettingsFor(position, device);
        const budgets = streamingBudgets(settings.streamingQuality, device.isMobile);
        expect(settings.streamingPointBudget).toBe(budgets.pointBudget);
        expect(settings.maxConcurrentDecodes).toBe(budgets.maxConcurrentDecodes);
      }
    }
  });

  it('gives a phone the mobile budgets, not the desktop ones', () => {
    const phone = qualitySettingsFor(QUALITY_MAX, PHONE);
    const desktop = qualitySettingsFor(QUALITY_MAX, DESKTOP);
    expect(phone.streamingQuality).toBe(desktop.streamingQuality);
    expect(phone.streamingPointBudget).toBeLessThan(desktop.streamingPointBudget);
  });
});

describe('quality policy — monotonicity', () => {
  it('never gets more expensive to the left, on any device', () => {
    for (const device of ALL_DEVICES) {
      expect(qualityPolicyIsMonotonic(device), JSON.stringify(device)).toBe(true);
    }
  });

  it('is monotonic across every integer position, not only the stops', () => {
    for (const device of ALL_DEVICES) {
      let previous = qualitySettingsFor(QUALITY_MIN, device);
      for (let position = QUALITY_MIN; position <= QUALITY_MAX; position += 1) {
        const current = qualitySettingsFor(position, device);
        expect(current.streamingPointBudget).toBeGreaterThanOrEqual(previous.streamingPointBudget);
        expect(current.maxPixelRatio).toBeGreaterThanOrEqual(previous.maxPixelRatio);
        expect(Number(current.edlEnabled)).toBeGreaterThanOrEqual(Number(previous.edlEnabled));
        expect(Number(current.antialiasing)).toBeGreaterThanOrEqual(Number(previous.antialiasing));
        previous = current;
      }
    }
  });
});

describe('quality policy — scope', () => {
  it('resolves display and streaming fields only', () => {
    for (const device of ALL_DEVICES) {
      const settings = qualitySettingsFor(midQualityPosition(), device);
      expect(Object.keys(settings).sort()).toEqual(SETTINGS_FIELDS);
    }
  });

  it('carries no field that could reach a measured number', () => {
    const settings = qualitySettingsFor(QUALITY_MAX, DESKTOP) as unknown as Record<string, unknown>;
    // The static LOAD budget voxel-reduces the decoded cloud that terrain
    // analysis, measurement and export all read. Naming it here in any spelling
    // would mean the slider had grown a way to move a computed quantity.
    for (const banned of ['renderBudget', 'loadBudget', 'budget', 'stride', 'decimation']) {
      expect(settings[banned]).toBeUndefined();
    }
  });
});

describe('quality policy — auto', () => {
  it('puts a weak device on the Speed end, which is the old degraded path', () => {
    expect(autoQualityPosition(WEAK)).toBe(QUALITY_MIN);
    const settings = qualitySettingsFor(autoQualityPosition(WEAK), WEAK);
    // What the shell used to do by hand for `tier === 'low'`.
    expect(settings.edlEnabled).toBe(false);
    expect(settings.antialiasing).toBe(false);
  });

  it('reproduces the viewer boot state on a WebGPU desktop', () => {
    const settings = qualitySettingsFor(autoQualityPosition(DESKTOP), DESKTOP);
    expect(settings.edlEnabled).toBe(true);
    expect(settings.antialiasing).toBe(true);
    expect(settings.maxPixelRatio).toBe(MAX_PIXEL_RATIO_DEFAULT);
    expect(settings.streamingQuality).toBe('balanced');
  });

  it('reproduces it on the WebGL 2 fallback and on a phone, where EDL defaults off', () => {
    for (const device of [DESKTOP_GL, PHONE]) {
      const settings = qualitySettingsFor(autoQualityPosition(device), device);
      expect(settings.edlEnabled, JSON.stringify(device)).toBe(false);
      expect(settings.antialiasing).toBe(true);
      expect(settings.maxPixelRatio).toBe(MAX_PIXEL_RATIO_DEFAULT);
      expect(settings.streamingQuality).toBe('balanced');
    }
  });

  it('always lands inside the slider range', () => {
    for (const device of ALL_DEVICES) {
      const position = autoQualityPosition(device);
      expect(position).toBeGreaterThanOrEqual(QUALITY_MIN);
      expect(position).toBeLessThanOrEqual(QUALITY_MAX);
    }
  });

  it('ignores the stored position while auto is on, and honours it once off', () => {
    const preference = { auto: true, position: QUALITY_MAX, overrides: {} };
    expect(resolveQualitySettings(preference, WEAK).position).toBe(QUALITY_MIN);
    expect(resolveQualitySettings({ ...preference, auto: false }, WEAK).position).toBe(QUALITY_MAX);
  });
});

describe('quality policy — advanced overrides', () => {
  it('pins one field without moving the others', () => {
    const base = resolveQualitySettings({ auto: false, position: QUALITY_MIN, overrides: {} }, DESKTOP);
    const pinned = resolveQualitySettings(
      { auto: false, position: QUALITY_MIN, overrides: { edlEnabled: true } },
      DESKTOP,
    );
    expect(pinned.edlEnabled).toBe(true);
    expect(pinned.antialiasing).toBe(base.antialiasing);
    expect(pinned.maxPixelRatio).toBe(base.maxPixelRatio);
    expect(pinned.streamingQuality).toBe(base.streamingQuality);
  });

  it('re-derives the streaming budgets from a pinned preset', () => {
    const pinned = resolveQualitySettings(
      { auto: false, position: QUALITY_MIN, overrides: { streamingQuality: 'high' } },
      DESKTOP,
    );
    expect(pinned.streamingPointBudget).toBe(streamingBudgets('high', false).pointBudget);
  });

  it('clamps a pinned pixel ratio into the module bounds', () => {
    const wild = resolveQualitySettings(
      { auto: false, position: QUALITY_MIN, overrides: { maxPixelRatio: 12 } },
      DESKTOP,
    );
    expect(wild.maxPixelRatio).toBe(MAX_PIXEL_RATIO_MAX);
  });
});

describe('pixel-ratio ceiling', () => {
  it('defaults to the historical Viewer cap', () => {
    expect(maxPixelRatio()).toBe(MAX_PIXEL_RATIO_DEFAULT);
    expect(MAX_PIXEL_RATIO_DEFAULT).toBe(1.5);
  });

  it('clamps into [min, max] and refuses a non-finite value', () => {
    expect(clampPixelRatioCeiling(0.1)).toBe(MAX_PIXEL_RATIO_MIN);
    expect(clampPixelRatioCeiling(9)).toBe(MAX_PIXEL_RATIO_MAX);
    expect(clampPixelRatioCeiling(Number.NaN)).toBe(MAX_PIXEL_RATIO_DEFAULT);
  });

  it('reports the value actually applied, and resets', () => {
    expect(setMaxPixelRatio(9)).toBe(MAX_PIXEL_RATIO_MAX);
    expect(maxPixelRatio()).toBe(MAX_PIXEL_RATIO_MAX);
    resetMaxPixelRatio();
    expect(maxPixelRatio()).toBe(MAX_PIXEL_RATIO_DEFAULT);
  });
});

describe('applying settings to the renderer', () => {
  interface Call {
    readonly name: string;
    readonly args: readonly unknown[];
  }

  function recordingHost(): { host: QualityRenderHost; calls: Call[] } {
    const calls: Call[] = [];
    const host: QualityRenderHost = {
      setEdlEnabled: (on) => { calls.push({ name: 'setEdlEnabled', args: [on] }); },
      setAntialiasing: (on) => { calls.push({ name: 'setAntialiasing', args: [on] }); },
      setStreamingQuality: (q: StreamingQuality, isMobile: boolean) => {
        calls.push({ name: 'setStreamingQuality', args: [q, isMobile] });
      },
      requestFrame: () => { calls.push({ name: 'requestFrame', args: [] }); },
    };
    return { host, calls };
  }

  it('writes the ceiling, pushes the display settings, then asks for a frame', () => {
    const { host, calls } = recordingHost();
    applyQualitySettings(host, qualitySettingsFor(QUALITY_MAX, DESKTOP), false);
    expect(maxPixelRatio()).toBe(MAX_PIXEL_RATIO_MAX);
    expect(calls.map((c) => c.name)).toEqual([
      'setEdlEnabled',
      'setAntialiasing',
      'setStreamingQuality',
      'requestFrame',
    ]);
    expect(calls[0].args).toEqual([true]);
    expect(calls[2].args).toEqual(['high', false]);
  });

  it('passes the device class through to the streaming budgets', () => {
    const { host, calls } = recordingHost();
    applyQualitySettings(host, qualitySettingsFor(QUALITY_MIN, PHONE), true);
    expect(calls[2].args).toEqual(['low', true]);
    expect(maxPixelRatio()).toBe(MAX_PIXEL_RATIO_MIN);
  });
});

describe('preference parsing', () => {
  it('starts automatic when nothing is stored', () => {
    expect(parseQualityPreference(null)).toEqual(DEFAULT_QUALITY_PREFERENCE);
    expect(parseQualityPreference('')).toEqual(DEFAULT_QUALITY_PREFERENCE);
  });

  it('degrades to automatic on malformed or hand-edited storage', () => {
    for (const raw of ['{', 'null', '"balanced"', '[1,2,3]', '17']) {
      expect(parseQualityPreference(raw).auto, raw).toBe(true);
    }
  });

  it('round-trips a real preference', () => {
    const stored = JSON.stringify({
      auto: false,
      position: 80,
      overrides: { streamingQuality: 'high', edlEnabled: true },
    });
    expect(parseQualityPreference(stored)).toEqual({
      auto: false,
      position: 80,
      overrides: { streamingQuality: 'high', edlEnabled: true },
    });
  });

  it('drops override fields that do not validate and clamps the ones that do', () => {
    const stored = JSON.stringify({
      auto: false,
      position: 5000,
      overrides: { streamingQuality: 'ludicrous', maxPixelRatio: 99, edlEnabled: 'yes' },
    });
    const parsed = parseQualityPreference(stored);
    expect(parsed.position).toBe(QUALITY_MAX);
    expect(parsed.overrides.streamingQuality).toBeUndefined();
    expect(parsed.overrides.edlEnabled).toBeUndefined();
    expect(parsed.overrides.maxPixelRatio).toBe(MAX_PIXEL_RATIO_MAX);
  });
});
