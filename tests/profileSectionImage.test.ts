/**
 * profileSectionImage.test.ts
 *
 * The exported section image against a recording 2D context.
 *
 * The rules under test are not "it drew something". They are:
 *
 *   every element the image promises is on it (plot, axes with their units,
 *   legend, scope, name, counts);
 *
 *   the counts the image discloses are the counts of the DRAW, so a splat the
 *   renderer skipped cannot be captioned as drawn, and the accepted total can
 *   never stand in for the drawn one;
 *
 *   the hover tooltip is never rastered, and a selected-point annotation
 *   appears only when the caller asked for one;
 *
 *   nothing that is not evidence is drawn before the evidence;
 *
 *   two composes of one request produce identical operations, so an export is
 *   reproducible.
 *
 * No jsdom: the context is a per-test recording stub, which is also what
 * proves the module never reaches for `document`.
 */

import { describe, it, expect } from 'vitest';
import {
  composeProfileSectionImage,
  profileCountsCaption,
  DEFAULT_PROFILE_IMAGE_THEME,
  type ProfileImageContext,
  type ProfileImageSurface,
  type ProfileSectionImageRequest,
} from '../src/render/measure/profileSectionImage';
import type { ProfileSectionPoints } from '../src/render/measure/profileSectionBuilder';
import type { ProfileSample } from '../src/render/measure/profileSampler';
import type { ProfileSectionStyle } from '../src/render/measure/profileSectionRenderer';
import type { ProfileViewport } from '../src/render/measure/profileViewTransform';

// ─────────────────────────────────────────────────────────────────────────────
// Recording context
// ─────────────────────────────────────────────────────────────────────────────

interface Op {
  readonly op: string;
  readonly args: readonly (number | string)[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly globalAlpha: number;
  readonly lineWidth: number;
  readonly font: string;
}

/**
 * A `CanvasRenderingContext2D` stand-in that records instead of drawing.
 *
 * It offers the drawing calls and nothing else, so a composer that tried to
 * build a DOM node, measure a string, or read a clock would have nowhere to do
 * it and would throw in the Node environment these tests run in.
 */
class RecordingContext implements ProfileImageContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  readonly ops: Op[] = [];

  private record(op: string, args: (number | string)[]): void {
    this.ops.push({
      op,
      args,
      fillStyle: String(this.fillStyle),
      strokeStyle: String(this.strokeStyle),
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
      font: this.font,
    });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.record('setTransform', [a, b, c, d, e, f]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.record('clearRect', [x, y, w, h]);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record('fillRect', [x, y, w, h]);
  }
  beginPath(): void {
    this.record('beginPath', []);
  }
  moveTo(x: number, y: number): void {
    this.record('moveTo', [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.record('lineTo', [x, y]);
  }
  stroke(): void {
    this.record('stroke', []);
  }
  fillText(text: string, x: number, y: number): void {
    this.record('fillText', [text, x, y]);
  }
  save(): void {
    this.record('save', []);
  }
  restore(): void {
    this.record('restore', []);
  }
  translate(x: number, y: number): void {
    this.record('translate', [x, y]);
  }
  rotate(angle: number): void {
    this.record('rotate', [angle]);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.record('rect', [x, y, w, h]);
  }
  clip(): void {
    this.record('clip', []);
  }

  names(): string[] {
    return this.ops.map((o) => o.op);
  }
  texts(): string[] {
    return this.ops.filter((o) => o.op === 'fillText').map((o) => String(o.args[0]));
  }
}

class RecordingSurface implements ProfileImageSurface {
  readonly ctx = new RecordingContext();
  readonly sizes: Array<[number, number]> = [];
  setBackingSize(deviceWidth: number, deviceHeight: number): void {
    this.sizes.push([deviceWidth, deviceHeight]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SIZE: ProfileViewport = { width: 900, height: 600, devicePixelRatio: 2 };

const STYLE: ProfileSectionStyle = {
  pointSizePx: 3,
  pointAlpha: 1,
  stationWidthPx: 1.5,
  stationColour: 'rgb(20, 30, 40)',
  stationAlpha: 0.5,
};

/** A splat is the only fill whose sides both equal the configured point size. */
function isSplat(op: Op): boolean {
  return (
    op.op === 'fillRect' &&
    op.args[2] === STYLE.pointSizePx &&
    op.args[3] === STYLE.pointSizePx
  );
}

function makePoints(chainage: number[], height: number[]): ProfileSectionPoints {
  const n = chainage.length;
  return {
    count: n,
    chainage: Float32Array.from(chainage),
    height: Float64Array.from(height),
    lateralOffset: new Float32Array(n),
    sourceSlot: new Uint16Array(n),
    pointIndex: Uint32Array.from(chainage.map((_, i) => i)),
    channelPresence: new Uint8Array(n),
  };
}

function colours(n: number): Uint8Array {
  const out = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = 40;
    out[i * 3 + 1] = 90 + i;
    out[i * 3 + 2] = 140;
  }
  return out;
}

const STATIONS: readonly ProfileSample[] = [
  { distance: 0, height: 10.1 },
  { distance: 10, height: 10.4 },
  { distance: 20, height: Number.NaN },
  { distance: 30, height: 11.0 },
  { distance: 40, height: 11.3 },
];

const LEGEND = {
  caption: 'Low-percentile station series (P15), 5 stations',
  lines: [
    'Estimate derived from returns; not a return series and not certified bare earth.',
    'Classification provenance: producer classification on every contributing source.',
    '1 of 5 stations is a coverage gap.',
  ],
};

/** A six-return section, all of it inside the fitted extent. */
function baseRequest(
  surface: RecordingSurface,
  overrides: Partial<ProfileSectionImageRequest> = {},
): ProfileSectionImageRequest {
  const points = makePoints([0, 10, 20, 30, 40, 50], [10, 10.5, 11, 11.4, 11.2, 10.8]);
  return {
    surface,
    size: SIZE,
    scene: {
      points,
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      colours: colours(6),
      stations: STATIONS,
    },
    bounds: { minChainage: 0, maxChainage: 50, minHeight: 10, maxHeight: 11.4 },
    scaleMode: { kind: 'fit' },
    axes: {
      reference: 'orthometric',
      horizontalUnit: 'm',
      verticalUnit: 'm',
      units: { horizontalToMetres: 1, verticalToMetres: 1 },
    },
    style: STYLE,
    name: 'Section A to B',
    scope: 'resident-snapshot',
    streamingComplete: null,
    acceptedCount: 400000,
    legend: LEGEND,
    generatedAt: '2026-08-23T12:00:00Z',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// What the image carries
// ─────────────────────────────────────────────────────────────────────────────

describe('composeProfileSectionImage — the image carries every required element', () => {
  it('draws the plot, the axes with their units, the legend, the scope, the name and both counts', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface));
    const drawn = surface.ctx.texts();

    // The plot: one splat per drawn return, and the derived series over it.
    expect(surface.ctx.ops.filter(isSplat).length).toBe(6);
    expect(surface.ctx.names()).toContain('stroke');

    // The name.
    expect(drawn).toContain('Section A to B');

    // The scope line, in the words `describeSectionScope` owns.
    expect(result.scopeLine).toBe('Resident snapshot, coverage unknown');
    expect(drawn).toContain('Source read: Resident snapshot, coverage unknown');

    // Axis titles, each carrying its own unit.
    expect(drawn).toContain('Chainage (m)');
    expect(drawn).toContain('Elevation (m)');

    // Tick labels: bare numbers, the unit left to the title.
    expect(result.axes.x.labels.length).toBeGreaterThan(1);
    for (const label of result.axes.x.labels) expect(drawn).toContain(label);

    // The legend, caption and every line.
    expect(drawn).toContain(LEGEND.caption);
    for (const line of LEGEND.lines) expect(drawn).toContain(line);

    // Both counts, on the face of the image.
    expect(drawn).toContain(result.countsCaption);
    expect(result.countsCaption).toContain('6');
    expect(result.countsCaption).toContain('400,000');

    // The scale statement and the timestamp.
    expect(drawn).toContain(result.scaleCaption);
    expect(drawn).toContain('Composed 2026-08-23T12:00:00Z');

    // The result restates exactly what was drawn, so a manifest or an alt text
    // cannot drift from the pixels.
    expect(result.texts).toEqual(drawn);
    expect(result.deviceWidth).toBe(1800);
    expect(result.deviceHeight).toBe(1200);
    expect(surface.sizes).toEqual([[1800, 1200]]);
  });

  it('states the axis unit in the title, and omits the brackets when there is no unit', () => {
    const withUnits = new RecordingSurface();
    composeProfileSectionImage(baseRequest(withUnits));
    expect(withUnits.ctx.texts()).toContain('Chainage (m)');

    const noUnits = new RecordingSurface();
    composeProfileSectionImage(
      baseRequest(noUnits, {
        axes: {
          reference: 'unknown',
          horizontalUnit: null,
          verticalUnit: null,
          units: { horizontalToMetres: null, verticalToMetres: null },
        },
      }),
    );
    const drawn = noUnits.ctx.texts();
    expect(drawn).toContain('Chainage');
    expect(drawn).not.toContain('Chainage (m)');
    expect(drawn).toContain('Height (datum unknown)');
  });

  it('names a derived series as derived even when the caller supplied no legend', () => {
    const surface = new RecordingSurface();
    composeProfileSectionImage(baseRequest(surface, { legend: null }));
    expect(surface.ctx.texts()).toContain(
      'A derived station series is drawn over the returns; no legend was supplied for it.',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The disclosure
// ─────────────────────────────────────────────────────────────────────────────

describe('composeProfileSectionImage — decimation is disclosed', () => {
  it('captions the drawn count against the accepted count, never the accepted count twice', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface));

    expect(result.drawnCount).toBe(6);
    expect(result.acceptedCount).toBe(400000);
    expect(result.decimated).toBe(true);
    expect(result.countsCaption).toBe(
      'Returns drawn: 6 of 400,000 accepted (0.0 %); a decimated sample of the section, not every accepted return.',
    );
    // The accepted figure alone must never be the whole disclosure.
    expect(result.countsCaption).not.toBe('Returns drawn: 400,000 of 400,000 accepted.');
    expect(surface.ctx.texts()).toContain(result.countsCaption);
  });

  it('reports a real share for a real decimation', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface, { acceptedCount: 20 }));
    expect(result.countsCaption).toContain('6 of 20 accepted (30.0 %)');
    expect(result.countsCaption).toContain('decimated sample');
  });

  it('says so plainly when nothing was dropped', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface, { acceptedCount: 6 }));
    expect(result.decimated).toBe(false);
    expect(result.countsCaption).toBe(
      'Returns drawn: 6 of 6 accepted (100.0 %); every accepted return is drawn.',
    );
    expect(surface.ctx.texts()).toContain(result.countsCaption);
  });

  it('counts the draw, not the index list: a skipped splat is never captioned as drawn', () => {
    const surface = new RecordingSurface();
    // Six points. One index is past the section, one point has a non-finite
    // height, and one sits far outside the fitted extent. Three can be drawn.
    const points = makePoints([0, 10, 20, 1e6, 40, 50], [10, 10.5, Number.NaN, 11, 11.2, 10.8]);
    const result = composeProfileSectionImage(
      baseRequest(surface, {
        scene: {
          points,
          indices: Uint32Array.from([0, 1, 2, 3, 4, 99]),
          colours: colours(6),
          stations: null,
        },
        bounds: { minChainage: 0, maxChainage: 50, minHeight: 10, maxHeight: 11.2 },
        acceptedCount: 6,
      }),
    );

    const splats = surface.ctx.ops.filter(isSplat).length;
    expect(splats).toBe(3);
    expect(result.drawnCount).toBe(splats);
    expect(result.clippedCount).toBe(1);
    expect(result.decimated).toBe(true);
    expect(result.countsCaption).toBe(
      'Returns drawn: 3 of 6 accepted (50.0 %); a decimated sample of the section, not every accepted return.',
    );
  });

  it('refuses to imply completeness when the accepted total was not recorded', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface, { acceptedCount: Number.NaN }));
    expect(result.decimated).toBe(false);
    expect(result.countsCaption).toContain('the accepted total was not recorded');
    expect(surface.ctx.texts()).toContain(result.countsCaption);
  });

  it('profileCountsCaption carries both numbers on every branch', () => {
    expect(profileCountsCaption(0, 0)).toBe('Returns drawn: 0 of 0 accepted; the section is empty.');
    expect(profileCountsCaption(120000, 400000)).toContain('120,000 of 400,000 accepted (30.0 %)');
    expect(profileCountsCaption(5, 3)).toContain('5 of 3 accepted');
    expect(profileCountsCaption(5, 3)).toContain('one of the two is wrong');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What must not reach the raster
// ─────────────────────────────────────────────────────────────────────────────

describe('composeProfileSectionImage — the hover tooltip and the annotation', () => {
  it('never rasters the hover readout, even when the caller passes it through', () => {
    const surface = new RecordingSurface();
    const hover = 'Return 4812 · 11.42 m · class 2';
    const result = composeProfileSectionImage(baseRequest(surface, { hoverLabel: hover }));
    for (const text of surface.ctx.texts()) expect(text).not.toContain(hover);
    for (const text of result.texts) expect(text).not.toContain('4812');
  });

  it('marks no selected point unless one was asked for', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface));
    expect(result.annotated).toBe(false);
    for (const text of result.texts) expect(text).not.toContain('Selected return');
  });

  it('marks the selected point when the caller asks, and labels it', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(
      baseRequest(surface, { annotation: { index: 3, label: '11.40 m at 30.00 m' } }),
    );
    expect(result.annotated).toBe(true);
    expect(surface.ctx.texts()).toContain('Selected return: 11.40 m at 30.00 m');
    expect(
      surface.ctx.ops.some(
        (o) => o.op === 'stroke' && o.strokeStyle === DEFAULT_PROFILE_IMAGE_THEME.annotation,
      ),
    ).toBe(true);
  });

  it('marks nothing for an index the section does not hold', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(
      baseRequest(surface, { annotation: { index: 99, label: 'nowhere' } }),
    );
    expect(result.annotated).toBe(false);
    expect(surface.ctx.texts()).not.toContain('Selected return: nowhere');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Order, scale, determinism
// ─────────────────────────────────────────────────────────────────────────────

describe('composeProfileSectionImage — order and reproducibility', () => {
  it('draws the evidence before anything that is not evidence', () => {
    const surface = new RecordingSurface();
    composeProfileSectionImage(baseRequest(surface));
    const ops = surface.ctx.ops;

    const plotGround = ops.findIndex(
      (o) => o.op === 'fillRect' && o.fillStyle === DEFAULT_PROFILE_IMAGE_THEME.plotBackground,
    );
    const firstSplat = ops.findIndex(isSplat);
    const lastSplat = ops.map(isSplat).lastIndexOf(true);
    const firstStroke = ops.findIndex((o) => o.op === 'stroke');
    const firstText = ops.findIndex((o) => o.op === 'fillText');

    expect(plotGround).toBeGreaterThanOrEqual(0);
    expect(firstText).toBeGreaterThanOrEqual(0);
    // Ground, then returns, then the derived series, then every label.
    expect(plotGround).toBeLessThan(firstSplat);
    expect(firstSplat).toBeLessThan(lastSplat);
    expect(lastSplat).toBeLessThan(firstStroke);
    expect(firstStroke).toBeLessThan(firstText);
  });

  it('clips the plot pass to the plot rectangle', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface));
    const names = surface.ctx.names();
    const clip = names.indexOf('clip');
    expect(clip).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('save')).toBeLessThan(clip);
    const rectOp = surface.ctx.ops.find((o) => o.op === 'rect');
    expect(rectOp?.args).toEqual([
      result.plot.x,
      result.plot.y,
      result.plot.width,
      result.plot.height,
    ]);
  });

  it('states the exaggeration it achieved, and discloses a fallback when the units cannot carry one', () => {
    const held = new RecordingSurface();
    const withVe = composeProfileSectionImage(
      baseRequest(held, { scaleMode: { kind: 've', ratio: 2 } }),
    );
    expect(withVe.scaleCaption).toBe('Scale: vertical exaggeration 2:1.');
    expect(held.ctx.texts()).toContain(withVe.scaleCaption);

    const unknown = new RecordingSurface();
    const fallback = composeProfileSectionImage(
      baseRequest(unknown, {
        scaleMode: { kind: 've', ratio: 2 },
        axes: {
          reference: 'local',
          horizontalUnit: null,
          verticalUnit: null,
          units: { horizontalToMetres: null, verticalToMetres: null },
        },
      }),
    );
    expect(fallback.scaleCaption).toBe(
      'Scale: fitted to the extent; a vertical exaggeration cannot be stated for these units.',
    );
    expect(unknown.ctx.texts()).toContain(fallback.scaleCaption);
    // The fallback still produced a drawable plot.
    expect(unknown.ctx.ops.filter(isSplat).length).toBe(6);
  });

  it('composes byte-identically twice from one request', () => {
    const a = new RecordingSurface();
    const b = new RecordingSurface();
    const ra = composeProfileSectionImage(baseRequest(a));
    const rb = composeProfileSectionImage(baseRequest(b));
    expect(JSON.stringify(b.ctx.ops)).toBe(JSON.stringify(a.ctx.ops));
    expect(rb.texts).toEqual(ra.texts);
    expect(rb.countsCaption).toBe(ra.countsCaption);
  });

  it('reads no clock: the timestamp line appears only when one was supplied', () => {
    const surface = new RecordingSurface();
    const result = composeProfileSectionImage(baseRequest(surface, { generatedAt: null }));
    for (const text of result.texts) expect(text).not.toContain('Composed ');
  });
});
