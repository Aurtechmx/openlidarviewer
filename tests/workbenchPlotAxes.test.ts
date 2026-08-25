/**
 * workbenchPlotAxes.test.ts
 *
 * What the docked workbench actually draws on its plot beyond the returns: the
 * grid rules, the tick labels, and the two axis titles.
 *
 * The plot is a canvas, so the only thing a reader can check is what was
 * asked of the context. The suite drives `prepareWorkbenchSection` against a
 * recording 2D context and asserts on the text it was told to draw and where.
 *
 * The height axis is the point of the exercise. A section with no declared
 * datum must be titled "Height (datum unknown)" and never "Elevation": a plot
 * outlives the reader's memory of which scan it came from, so the axis is
 * where the surface a height was measured from is stated or lost.
 */

import { describe, it, expect } from 'vitest';
import {
  AXIS_FONT_PX,
  AXIS_LABEL_INSET_PX,
  drawWorkbenchAxes,
  prepareWorkbenchSection,
} from '../src/app/profileWorkbenchSection';
import {
  AXIS_LABEL_MIN_GAP_PX,
  axisLabelWidth,
  profileAxes,
} from '../src/render/measure/profileAxes';
import { fitProfileView } from '../src/render/measure/profileViewTransform';
import type { ProfileViewport } from '../src/render/measure/profileViewTransform';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';

/** One `fillText` call, as the plot made it. */
interface DrawnText {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly align: string;
  readonly baseline: string;
}

/** A 2D context that records the calls the axis code makes. */
function recordingContext() {
  const texts: DrawnText[] = [];
  const lines: [number, number, number, number][] = [];
  let from: [number, number] = [0, 0];
  const ctx = {
    fillStyle: '' as string,
    strokeStyle: '' as string,
    lineWidth: 0,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    setTransform: (): void => {},
    clearRect: (): void => {},
    fillRect: (): void => {},
    beginPath: (): void => {},
    moveTo: (x: number, y: number): void => {
      from = [x, y];
    },
    lineTo: (x: number, y: number): void => {
      lines.push([from[0], from[1], x, y]);
    },
    stroke: (): void => {},
    fillText: (text: string, x: number, y: number): void => {
      texts.push({ text, x, y, align: ctx.textAlign, baseline: ctx.textBaseline });
    },
    texts,
    lines,
  };
  return ctx;
}

class FakeCanvas {
  width = 0;
  height = 0;
  readonly ctx = recordingContext();
  readonly clientWidth: number;
  readonly clientHeight: number;
  constructor(clientWidth: number, clientHeight: number) {
    this.clientWidth = clientWidth;
    this.clientHeight = clientHeight;
  }
  getContext(): ReturnType<typeof recordingContext> {
    return this.ctx;
  }
}

/** A ramp section: a chainage run with a real height range over it. */
function rampSection(count: number): ProfileSectionResult {
  const chainage = new Float32Array(count);
  const height = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    chainage[i] = (i / (count - 1)) * 241.31 - 3.7;
    height[i] = 1103.04 + (i / (count - 1)) * 28.86;
  }
  return {
    points: {
      count,
      chainage,
      height,
      lateralOffset: new Float32Array(count),
      sourceSlot: new Uint16Array(count),
      pointIndex: new Uint32Array(count),
      channelPresence: new Uint8Array(count),
    },
    frame: null as never,
    band: 2,
    scope: 'static' as never,
    scopeLabel: 'One loaded layer.',
    streamingComplete: null,
    sources: [],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  } as unknown as ProfileSectionResult;
}

/** A section far out on a projected grid: every chainage label is seven digits. */
function farFieldSection(count: number): ProfileSectionResult {
  const section = rampSection(count);
  const chainage = section.points.chainage as Float32Array;
  for (let i = 0; i < count; i++) chainage[i] = 1_250_000 + (i / (count - 1)) * 500;
  return section;
}

describe('the workbench plot carries axis indicators', () => {
  it('draws chainage and height titles, and grid rules on both axes', () => {
    const canvas = new FakeCanvas(640, 320);
    prepareWorkbenchSection({
      section: rampSection(200),
      canvas,
      unitSuffix: 'm',
      unitScale: 1,
      reference: 'orthometric',
    });
    const drawn = canvas.ctx.texts.map((t) => t.text);
    expect(drawn).toContain('Chainage (m)');
    expect(drawn).toContain('Elevation (m)');
    // Rules on both axes: at least one full-height and one full-width line.
    expect(canvas.ctx.lines.some(([x1, y1, x2, y2]) => x1 === x2 && y1 === 0 && y2 === 320)).toBe(
      true,
    );
    expect(canvas.ctx.lines.some(([x1, y1, x2, y2]) => y1 === y2 && x1 === 0 && x2 === 640)).toBe(
      true,
    );
  });

  it('titles the height axis "Height (datum unknown)" when no datum was declared', () => {
    const canvas = new FakeCanvas(640, 320);
    prepareWorkbenchSection({
      section: rampSection(200),
      canvas,
      unitSuffix: 'm',
      unitScale: 1,
      reference: 'unknown',
    });
    const drawn = canvas.ctx.texts.map((t) => t.text);
    expect(drawn).toContain('Height (datum unknown) (m)');
    expect(drawn.join(' ')).not.toContain('Elevation');
  });

  it('says nothing about a datum a caller did not state', () => {
    // No `reference` at all is the same case as an unresolved CRS, and the
    // plot must default to the honest wording rather than to an elevation.
    const canvas = new FakeCanvas(640, 320);
    prepareWorkbenchSection({ section: rampSection(200), canvas, unitSuffix: 'm', unitScale: 1 });
    expect(canvas.ctx.texts.map((t) => t.text).join(' ')).toContain('Height (datum unknown)');
  });

  it('prints bare numbers on a frame whose render units are not the stated unit', () => {
    // A foot-CRS scan: the spans in the detail list are converted to metres,
    // but the ticks are read off the section in its own units, so the axis
    // must not label them with a unit they are not in.
    const canvas = new FakeCanvas(640, 320);
    prepareWorkbenchSection({
      section: rampSection(200),
      canvas,
      unitSuffix: 'm',
      unitScale: 0.3048,
      reference: 'unknown',
    });
    const drawn = canvas.ctx.texts.map((t) => t.text);
    expect(drawn).toContain('Chainage');
    expect(drawn).not.toContain('Chainage (m)');
  });

  it('draws no labels that overlap, at the narrowest plot the dock permits', () => {
    const viewport: ProfileViewport = { width: 180, height: 96, devicePixelRatio: 1 };
    const canvas = new FakeCanvas(viewport.width, viewport.height);
    prepareWorkbenchSection({
      section: rampSection(200),
      canvas,
      unitSuffix: 'm',
      unitScale: 1,
      reference: 'unknown',
    });
    // The tick labels are the centred, bottom-aligned run; the two titles are
    // drawn with the other alignments and are not competing with them.
    const ticks = canvas.ctx.texts
      .filter((t) => t.align === 'center' && t.baseline === 'bottom')
      .map((t) => ({
        start: t.x - axisLabelWidth(t.text, AXIS_FONT_PX) / 2,
        end: t.x + axisLabelWidth(t.text, AXIS_FONT_PX) / 2,
      }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < ticks.length; i++) {
      expect(
        ticks[i]!.start - ticks[i - 1]!.end,
        'two chainage labels were drawn touching',
      ).toBeGreaterThanOrEqual(AXIS_LABEL_MIN_GAP_PX);
    }
    // Stacked height labels: a line apart, down the left inset.
    const heights = canvas.ctx.texts
      .filter((t) => t.align === 'left' && t.baseline === 'middle')
      .map((t) => t.y)
      .sort((a, b) => a - b);
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]! - heights[i - 1]!).toBeGreaterThanOrEqual(
        AXIS_FONT_PX + AXIS_LABEL_MIN_GAP_PX,
      );
    }
    // And every one of them inside the plot the reader can see.
    for (const t of canvas.ctx.texts) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(viewport.width);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeLessThanOrEqual(viewport.height);
    }
  });

  it('drops chainage labels a narrow plot cannot hold rather than stacking them', () => {
    // Seven-digit chainage on a 180 px plot. The tick scale is chosen from the
    // section's span, not from how much room a label needs, so at this width
    // the numbers are wider than the space between the rules they belong to.
    // Every label drawn has to be clear of its neighbour anyway.
    const viewport: ProfileViewport = { width: 180, height: 96, devicePixelRatio: 1 };
    const canvas = new FakeCanvas(viewport.width, viewport.height);
    prepareWorkbenchSection({
      section: farFieldSection(200),
      canvas,
      unitSuffix: 'm',
      unitScale: 1,
      reference: 'unknown',
    });
    const ticks = canvas.ctx.texts
      .filter((t) => t.align === 'center' && t.baseline === 'bottom')
      .map((t) => ({
        text: t.text,
        start: t.x - axisLabelWidth(t.text, AXIS_FONT_PX) / 2,
        end: t.x + axisLabelWidth(t.text, AXIS_FONT_PX) / 2,
      }))
      .sort((a, b) => a.start - b.start);
    // The labels really are wide enough to collide if nothing dropped any.
    expect(ticks.every((t) => t.text.length >= 7)).toBe(true);
    for (let i = 1; i < ticks.length; i++) {
      expect(
        ticks[i]!.start - ticks[i - 1]!.end,
        `"${ticks[i - 1]!.text}" and "${ticks[i]!.text}" were drawn touching`,
      ).toBeGreaterThanOrEqual(AXIS_LABEL_MIN_GAP_PX);
    }
    for (const t of ticks) {
      expect(t.start).toBeGreaterThanOrEqual(0);
      expect(t.end).toBeLessThanOrEqual(viewport.width);
    }
  });

  it('draws the rules but no words for a context that cannot render text', () => {
    // An older double, or a browser context missing the text calls. The grid
    // still lands; nothing throws on the way to it.
    const viewport: ProfileViewport = { width: 400, height: 200, devicePixelRatio: 1 };
    const view = fitProfileView(
      { minChainage: 0, maxChainage: 100, minHeight: 0, maxHeight: 10 },
      viewport,
      { kind: 'fit' },
      { horizontalToMetres: null, verticalToMetres: null },
    );
    if (!view) throw new Error('the fixture must produce a view');
    const bare = recordingContext() as Record<string, unknown>;
    delete bare.fillText;
    expect(() =>
      drawWorkbenchAxes(
        bare as never,
        profileAxes(view, viewport, {
          reference: 'unknown',
          horizontalUnit: 'm',
          verticalUnit: 'm',
          units: { horizontalToMetres: null, verticalToMetres: null },
        }),
        viewport,
      ),
    ).not.toThrow();
    expect((bare.lines as unknown[]).length).toBeGreaterThan(0);
  });

  it('insets its labels from the edge rather than sitting on it', () => {
    const canvas = new FakeCanvas(640, 320);
    prepareWorkbenchSection({
      section: rampSection(200),
      canvas,
      unitSuffix: 'm',
      unitScale: 1,
      reference: 'unknown',
    });
    const left = canvas.ctx.texts.filter((t) => t.align === 'left' && t.baseline === 'middle');
    expect(left.length).toBeGreaterThan(0);
    for (const t of left) expect(t.x).toBe(AXIS_LABEL_INSET_PX);
  });
});
