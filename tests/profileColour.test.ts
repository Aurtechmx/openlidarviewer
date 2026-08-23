/**
 * profileColour.test.ts — the five colouring rules a profile section owes a
 * reader, each pinned by its own case.
 *
 * The fixtures are two-source sections, because every rule here is about a
 * section whose sources disagree: slot 0 carries intensity, GPS time, RGB and
 * return number, slot 1 carries none of them. Heights are 100..111 on slot 0
 * and 200..211 on slot 1, so a section-local window, an active-layer window,
 * and a project window are three visibly different pictures of the same cut.
 *
 *   1. unordered ids never reach a sequential ramp
 *   2. classification is OLV's class palette, colourblind setting included
 *   3. a missing attribute is unknown, not zero
 *   4. a mode with too little behind it is refused
 *   5. the height window states which scope it came from
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach } from 'vitest';
import {
  DEFAULT_ELEVATION_PALETTE,
  DEFAULT_SCALAR_PALETTE,
  ELEVATION_PALETTES,
  classColor,
  colorblindSafeClasses,
  elevationRampColor,
  setColorblindSafeClasses,
} from '../src/render/colorModes';
import {
  DEFAULT_PROFILE_HEIGHT_SCOPE,
  PROFILE_COLOUR_MODES,
  PROFILE_MODE_MIN_FRACTION,
  PROFILE_MODE_MIN_POINTS,
  PROFILE_UNKNOWN_COLOUR,
  availableProfileColourModes,
  colourProfileSection,
  profileColourKind,
  profileModeAvailability,
  profileRampPalette,
  type ProfileColourMode,
  type ProfileColourRequest,
} from '../src/render/measure/profileColour';
import {
  ProfileSectionBuilder,
  type ProfileSectionPoints,
  type ProfileSourceChannels,
} from '../src/render/measure/profileSectionBuilder';

// ── fixtures ────────────────────────────────────────────────────────────────

interface SourceSpec {
  readonly slot: number;
  readonly count: number;
  readonly height: (j: number) => number;
  readonly channels: ProfileSourceChannels | null;
}

function section(specs: readonly SourceSpec[]): ProfileSectionPoints {
  const b = new ProfileSectionBuilder();
  for (const s of specs) {
    b.beginSource(s.slot, s.channels, s.count);
    for (let j = 0; j < s.count; j++) b.push(j, j * 0.5, s.height(j), 0);
  }
  return b.finish();
}

const all = (p: ProfileSectionPoints): number[] => Array.from({ length: p.count }, (_, i) => i);

function colourAt(out: Uint8Array, k: number): [number, number, number] {
  return [out[k * 3], out[k * 3 + 1], out[k * 3 + 2]];
}

function run(request: ProfileColourRequest) {
  const out = new Uint8Array(request.indices.length * 3);
  const result = colourProfileSection(request, out);
  return { out, result };
}

const RICH = 12;

/** Slot 0: carries everything. Intensity starts at a measured 0. */
function richChannels(): ProfileSourceChannels {
  const rgb = new Uint8Array(RICH * 3);
  const intensity = new Uint16Array(RICH);
  const classification = new Uint8Array(RICH);
  const returnNumber = new Uint8Array(RICH);
  const pointSourceId = new Uint16Array(RICH);
  const gpsTime = new Float64Array(RICH);
  for (let j = 0; j < RICH; j++) {
    rgb[j * 3] = 10 + j;
    rgb[j * 3 + 1] = 20 + j;
    rgb[j * 3 + 2] = 30 + j;
    intensity[j] = j * 100;
    classification[j] = j % 2 === 0 ? 2 : 6;
    returnNumber[j] = (j % 2) + 1;
    pointSourceId[j] = 7;
    gpsTime[j] = 3.0e8 + j * 0.25;
  }
  return { rgb, intensity, classification, returnNumber, pointSourceId, gpsTime };
}

/** Slot 1: classification and a flight-line id only. No intensity at all. */
function poorChannels(): ProfileSourceChannels {
  const classification = new Uint8Array(RICH);
  const pointSourceId = new Uint16Array(RICH);
  for (let j = 0; j < RICH; j++) {
    classification[j] = j % 2 === 0 ? 2 : 5;
    pointSourceId[j] = 3;
  }
  return { classification, pointSourceId };
}

/** Indices 0–11 = slot 0 (rich, heights 100–111), 12–23 = slot 1 (heights 200–211). */
const mixed = (): ProfileSectionPoints =>
  section([
    { slot: 0, count: RICH, height: (j) => 100 + j, channels: richChannels() },
    { slot: 1, count: RICH, height: (j) => 200 + j, channels: poorChannels() },
  ]);

/** Slot 1 carries nothing at all, so half the section has no classification. */
const halfClassified = (): ProfileSectionPoints =>
  section([
    { slot: 0, count: RICH, height: (j) => 100 + j, channels: richChannels() },
    { slot: 1, count: RICH, height: (j) => 200 + j, channels: null },
  ]);

function intensityOnly(count: number, f: (j: number) => number): ProfileSourceChannels {
  const intensity = new Uint16Array(count);
  for (let j = 0; j < count; j++) intensity[j] = f(j);
  return { intensity };
}

afterEach(() => setColorblindSafeClasses(false));

// ── rule 1: unordered ids never take a sequential ramp ───────────────────────

describe('unordered ids stay categorical', () => {
  it('routes point source id and source layer away from every ramp', () => {
    expect(profileColourKind('pointSourceId')).toBe('categorical');
    expect(profileColourKind('sourceLayer')).toBe('categorical');
    expect(profileColourKind('returnNumber')).toBe('ramp');

    // `profileRampPalette` is the module's only door to a ramp, and its
    // parameter type refuses an unordered id — the same refusal `colorModes.ts`
    // makes by leaving `pointSourceId` out of its `ColorMode` union.
    // @ts-expect-error pointSourceId is not a ProfileRampMode
    expect(() => profileRampPalette('pointSourceId')).toBeTypeOf('function');
  });

  it('gives neither id mode a palette, a range, or any ramp colour', () => {
    // Five flight lines, so a sequential encoding would have five ramp stops to
    // land on: t = 0, 0.25, 0.5, 0.75, 1.
    const ids = [1, 1, 1, 1, 4, 4, 4, 4, 9, 9, 9, 9, 12, 12, 12, 12, 30, 30, 30, 30];
    const pointSourceId = Uint16Array.from(ids);
    const points = section([
      { slot: 0, count: ids.length, height: (j) => j, channels: { pointSourceId } },
    ]);
    const indices = all(points);

    for (const mode of ['pointSourceId', 'sourceLayer'] as const) {
      const src =
        mode === 'pointSourceId'
          ? points
          : section([
              { slot: 0, count: 6, height: (j) => j, channels: null },
              { slot: 1, count: 6, height: (j) => 10 + j, channels: null },
              { slot: 2, count: 6, height: (j) => 20 + j, channels: null },
              { slot: 3, count: 6, height: (j) => 30 + j, channels: null },
              { slot: 4, count: 6, height: (j) => 40 + j, channels: null },
            ]);
      const idx = mode === 'pointSourceId' ? indices : all(src);
      const { result } = run({ points: src, mode, indices: idx });

      expect(result.legend.kind).toBe('categorical');
      expect(result.legend.palette).toBeNull();
      expect(result.legend.range).toBeNull();
      expect(result.legend.categories).toHaveLength(5);

      const swatches = result.legend.categories!.map((c) => c.colour);
      // No swatch is the colour a sequential ramp would put at its rank, in
      // ANY catalogue palette — Cividis and Turbo included.
      for (const palette of ELEVATION_PALETTES) {
        for (let rank = 0; rank < swatches.length; rank++) {
          const ramp = elevationRampColor(rank / (swatches.length - 1), palette.id);
          expect(swatches[rank]).not.toEqual(ramp);
        }
      }
      // A sequential ramp is monotonic in luminance. This palette is not, so
      // the swatch order cannot be read as an ordering.
      const luma = swatches.map((c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
      const rising = luma.every((v, i) => i === 0 || v >= luma[i - 1]);
      const falling = luma.every((v, i) => i === 0 || v <= luma[i - 1]);
      expect(rising || falling).toBe(false);
    }
  });

  it('assigns a category colour by sorted id, so draw order cannot change it', () => {
    const points = mixed();
    const forwards = run({ points, mode: 'pointSourceId', indices: all(points) });
    const backwards = run({
      points,
      mode: 'pointSourceId',
      indices: all(points).reverse(),
    });

    for (let i = 0; i < points.count; i++) {
      const k = points.count - 1 - i;
      expect(colourAt(backwards.out, k)).toEqual(colourAt(forwards.out, i));
    }
    // Ids 3 and 7: 3 sorts first and takes the first swatch, in both passes.
    expect(forwards.result.legend.categories!.map((c) => c.value)).toEqual([3, 7]);
    expect(backwards.result.legend.categories![0].colour).toEqual(
      forwards.result.legend.categories![0].colour,
    );
  });

  it('draws no colour from a random source', () => {
    const src = readFileSync(
      new URL('../src/render/measure/profileColour.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(/Math\.random/);
  });
});

// ── rule 2: classification is OLV's class palette ────────────────────────────

describe('classification reuses the class palette', () => {
  it('paints every code exactly what classColor gives it', () => {
    const points = mixed();
    const { out, result } = run({ points, mode: 'classification', indices: all(points) });

    expect(colourAt(out, 0)).toEqual(classColor(2)); // slot 0, code 2
    expect(colourAt(out, 1)).toEqual(classColor(6)); // slot 0, code 6
    expect(colourAt(out, 13)).toEqual(classColor(5)); // slot 1, code 5
    for (const c of result.legend.categories!) {
      expect(c.colour).toEqual(classColor(c.value));
    }
    expect(result.legend.categories!.map((c) => c.value)).toEqual([2, 5, 6]);
  });

  it('follows the global colourblind-safe setting for classes', () => {
    const points = mixed();
    expect(colorblindSafeClasses()).toBe(false);
    const plain = run({ points, mode: 'classification', indices: all(points) });
    expect(plain.result.legend.colourblindSafe).toBe(false);

    setColorblindSafeClasses(true);
    const safe = run({ points, mode: 'classification', indices: all(points) });

    expect(safe.result.legend.colourblindSafe).toBe(true);
    expect(colourAt(safe.out, 0)).not.toEqual(colourAt(plain.out, 0));
    expect(colourAt(safe.out, 0)).toEqual(classColor(2));
    expect(safe.result.legend.categories!.map((c) => c.colour)).toEqual(
      safe.result.legend.categories!.map((c) => classColor(c.value)),
    );
  });

  it('follows the same setting for the qualitative id palette', () => {
    const points = mixed();
    const plain = run({ points, mode: 'pointSourceId', indices: all(points) });
    setColorblindSafeClasses(true);
    const safe = run({ points, mode: 'pointSourceId', indices: all(points) });

    expect(safe.result.legend.colourblindSafe).toBe(true);
    expect(colourAt(safe.out, 0)).not.toEqual(colourAt(plain.out, 0));
  });
});

// ── rule 3: a missing attribute is unknown, never zero ───────────────────────

describe('a missing attribute is not a zero', () => {
  it('separates an absent intensity from a measured intensity of 0', () => {
    const points = mixed();
    const { out, result } = run({ points, mode: 'intensity', indices: all(points) });

    // Section index 0 is slot 0's first return: intensity measured as 0, the
    // bottom of the window, so it takes the ramp's bottom colour.
    const bottom = elevationRampColor(0, DEFAULT_SCALAR_PALETTE);
    expect(points.intensity![0]).toBe(0);
    expect(colourAt(out, 0)).toEqual(bottom);

    // Section index 12 is slot 1, which carries no intensity at all.
    expect(colourAt(out, 12)).toEqual([...PROFILE_UNKNOWN_COLOUR]);
    expect(colourAt(out, 12)).not.toEqual(bottom);
    expect(colourAt(out, 12)).not.toEqual(colourAt(out, 0));

    // The absent points never entered the window either.
    expect(result.legend.range!.min).toBe(0);
    expect(result.legend.range!.max).toBe(1100);
    expect(result.unknownCount).toBe(RICH);
  });

  it('reports the unknown points in the legend', () => {
    const points = mixed();
    const { result } = run({ points, mode: 'intensity', indices: all(points) });

    expect(result.legend.unknown).not.toBeNull();
    expect(result.legend.unknown!.count).toBe(RICH);
    expect(result.legend.unknown!.colour).toEqual(PROFILE_UNKNOWN_COLOUR);
    expect(result.legend.unknown!.label).toMatch(/unknown/i);
  });

  it('leaves no unknown bucket when every point carries the attribute', () => {
    const points = mixed();
    const { result } = run({ points, mode: 'classification', indices: all(points) });
    expect(result.unknownCount).toBe(0);
    expect(result.legend.unknown).toBeNull();
  });

  it('does not read an absent classification as "never classified"', () => {
    const points = halfClassified();
    const { out, result } = run({ points, mode: 'classification', indices: all(points) });

    expect(colourAt(out, 12)).toEqual([...PROFILE_UNKNOWN_COLOUR]);
    expect(colourAt(out, 12)).not.toEqual(classColor(0));
    expect(result.legend.unknown!.count).toBe(RICH);
    expect(result.legend.categories!.map((c) => c.value)).toEqual([2, 6]);
  });
});

// ── rule 4: a mode with too little behind it is refused ──────────────────────

describe('mode availability', () => {
  it('refuses an attribute no source carries', () => {
    const points = mixed();
    const a = profileModeAvailability(points, 'rgb', all(points));
    expect(a.available).toBe(true);

    const bare = section([{ slot: 0, count: 12, height: (j) => j, channels: null }]);
    const gps = profileModeAvailability(bare, 'gpsTime', all(bare));
    expect(gps.available).toBe(false);
    expect(gps.reason).toBe('absent');
  });

  it('refuses a mode carried by fewer than the minimum number of points', () => {
    const points = section([
      { slot: 0, count: 20, height: (j) => j, channels: null },
      { slot: 1, count: 4, height: (j) => 50 + j, channels: intensityOnly(4, (j) => j * 10) },
    ]);
    const a = profileModeAvailability(points, 'intensity', all(points));
    expect(a.supporting).toBe(4);
    expect(a.supporting).toBeLessThan(PROFILE_MODE_MIN_POINTS);
    expect(a.reason).toBe('tooFewPoints');
    expect(a.available).toBe(false);
    expect(availableProfileColourModes(points, all(points))).not.toContain('intensity');
  });

  it('refuses a mode carried by too small a share of the section', () => {
    const points = section([
      { slot: 0, count: 50, height: (j) => j, channels: null },
      { slot: 1, count: 10, height: (j) => 50 + j, channels: intensityOnly(10, (j) => j * 10) },
    ]);
    const a = profileModeAvailability(points, 'intensity', all(points));
    expect(a.supporting).toBe(10);
    expect(a.supporting / a.displayed).toBeLessThan(PROFILE_MODE_MIN_FRACTION);
    expect(a.reason).toBe('tooSmallFraction');
    expect(a.available).toBe(false);
  });

  it('refuses a mode whose supporting points all hold one value', () => {
    const points = section([
      {
        slot: 0,
        count: 12,
        height: (j) => j,
        channels: { classification: new Uint8Array(12).fill(2) },
      },
    ]);
    const a = profileModeAvailability(points, 'classification', all(points));
    expect(a.reason).toBe('noVariation');
    expect(a.available).toBe(false);
    // One flight line is one swatch, and the same rule applies.
    expect(profileModeAvailability(points, 'sourceLayer', all(points)).reason).toBe('noVariation');
    // Height still varies here, so it stays on offer.
    expect(profileModeAvailability(points, 'height', all(points)).available).toBe(true);
  });

  it('paints a refused mode as unknown rather than encoding it', () => {
    const points = section([
      { slot: 0, count: 20, height: (j) => j, channels: null },
      { slot: 1, count: 4, height: (j) => 50 + j, channels: intensityOnly(4, (j) => j * 10) },
    ]);
    const { out, result } = run({ points, mode: 'intensity', indices: all(points) });

    expect(result.legend.kind).toBe('unavailable');
    expect(result.legend.range).toBeNull();
    expect(result.unknownCount).toBe(points.count);
    // Including the four points that DO carry intensity: a mode this thin is
    // not encoded at all.
    expect(colourAt(out, 21)).toEqual([...PROFILE_UNKNOWN_COLOUR]);
  });

  it('lists only the modes the section supports', () => {
    const points = mixed();
    const modes = availableProfileColourModes(points, all(points));
    expect(modes).toEqual(
      PROFILE_COLOUR_MODES.filter((m) => modes.includes(m as ProfileColourMode)),
    );
    for (const m of ['rgb', 'height', 'intensity', 'classification', 'sourceLayer'] as const) {
      expect(modes).toContain(m);
    }
  });
});

// ── rule 5: the height window names its scope ────────────────────────────────

describe('the height window states which range it used', () => {
  it('reports the section-local window by default, and says so', () => {
    const points = mixed();
    const { result } = run({ points, mode: 'height', indices: all(points) });

    expect(DEFAULT_PROFILE_HEIGHT_SCOPE.scope).toBe('sectionLocal');
    expect(result.legend.range!.scope).toBe('sectionLocal');
    expect(result.legend.range!.label).toBe('This section');
    expect(result.legend.range!.min).toBe(101);
    expect(result.legend.range!.max).toBe(210);
    expect(result.legend.range!.trueMin).toBe(100);
    expect(result.legend.range!.trueMax).toBe(211);
    expect(result.legend.palette).toBe(DEFAULT_ELEVATION_PALETTE);
  });

  it('normalises one layer against itself when the active layer is asked for', () => {
    const points = mixed();
    const { result } = run({
      points,
      mode: 'height',
      indices: all(points),
      heightRange: { scope: 'activeLayer', slot: 1 },
    });

    expect(result.legend.range!.scope).toBe('activeLayer');
    expect(result.legend.range!.slot).toBe(1);
    expect(result.legend.range!.label).toBe('Active layer');
    expect(result.legend.range!.min).toBe(200);
    expect(result.legend.range!.max).toBe(211);
  });

  it('takes a project window verbatim so two sections stay comparable', () => {
    const points = mixed();
    const { result } = run({
      points,
      mode: 'height',
      indices: all(points),
      heightRange: { scope: 'projectShared', min: 0, max: 1000 },
    });

    expect(result.legend.range!.scope).toBe('projectShared');
    expect(result.legend.range!.min).toBe(0);
    expect(result.legend.range!.max).toBe(1000);
    expect(result.legend.range!.label).toBe('Project shared');
  });

  it('keeps a section-local request off the project window', () => {
    const points = mixed();
    const local = run({
      points,
      mode: 'height',
      indices: all(points),
      heightRange: { scope: 'sectionLocal' },
    });
    const shared = run({
      points,
      mode: 'height',
      indices: all(points),
      heightRange: { scope: 'projectShared', min: 0, max: 1000 },
    });
    const layer = run({
      points,
      mode: 'height',
      indices: all(points),
      heightRange: { scope: 'activeLayer', slot: 1 },
    });

    expect(local.result.legend.range!.scope).toBe('sectionLocal');
    expect(local.result.legend.range!.min).not.toBe(0);
    expect(local.result.legend.range!.max).not.toBe(1000);

    // Section index 12 is slot 1's lowest return. The three scopes put it at
    // three different places on the ramp, so the picture differs too.
    expect(colourAt(local.out, 12)).not.toEqual(colourAt(shared.out, 12));
    expect(colourAt(local.out, 12)).not.toEqual(colourAt(layer.out, 12));
    expect(colourAt(shared.out, 12)).not.toEqual(colourAt(layer.out, 12));
  });

  it('names the section as the scope for the non-height scalars', () => {
    const points = mixed();
    for (const mode of ['intensity', 'returnNumber', 'gpsTime'] as const) {
      const { result } = run({ points, mode, indices: all(points) });
      expect(result.legend.range!.scope).toBe('sectionLocal');
      expect(result.legend.palette).toBe(DEFAULT_SCALAR_PALETTE);
    }
  });

  it('ranges return number on the raw ordinals rather than a percentile band', () => {
    const points = mixed();
    const { result } = run({ points, mode: 'returnNumber', indices: all(points) });
    expect(result.legend.range!.min).toBe(1);
    expect(result.legend.range!.max).toBe(2);
  });
});

// ── output shape ─────────────────────────────────────────────────────────────

describe('output buffer', () => {
  it('fills the caller-owned buffer and reports how much it wrote', () => {
    const points = mixed();
    const indices = [3, 5, 7, 9, 11, 13, 15, 17, 19, 21];
    const out = new Uint8Array(indices.length * 3 + 6).fill(1);
    const result = colourProfileSection({ points, mode: 'height', indices }, out);

    expect(result.count).toBe(indices.length);
    // The tail beyond the written triplets is untouched.
    expect([...out.slice(indices.length * 3)]).toEqual([1, 1, 1, 1, 1, 1]);
    expect(colourAt(out, 0)).not.toEqual([1, 1, 1]);
  });

  it('refuses a buffer that cannot hold the section', () => {
    const points = mixed();
    const indices = all(points);
    expect(() =>
      colourProfileSection({ points, mode: 'height', indices }, new Uint8Array(3)),
    ).toThrow(RangeError);
  });

  it('copies RGB through unchanged where a source carries it', () => {
    const points = mixed();
    const { out } = run({ points, mode: 'rgb', indices: all(points) });
    expect(colourAt(out, 4)).toEqual([14, 24, 34]);
    expect(colourAt(out, 12)).toEqual([...PROFILE_UNKNOWN_COLOUR]);
  });
});
