/**
 * profileSectionRenderer.test.ts
 *
 * The section renderer against a recording 2D context.
 *
 * Every expected screen position is computed here from the transform's own
 * definition, written out in full, rather than by calling the renderer twice
 * and comparing it with itself. Chainage is stored float32, so an expectation
 * that ignored `Math.fround` would be testing a number the renderer never
 * saw.
 */

import { describe, it, expect } from 'vitest';
import {
  ProfileSectionRenderer,
  MAX_STATION_ALPHA,
  type ProfileRenderingContext,
  type ProfileSectionFrame,
  type ProfileSectionScene,
  type ProfileSectionStyle,
  type ProfileSurface,
} from '../src/render/measure/profileSectionRenderer';
import type { ProfileSectionPoints } from '../src/render/measure/profileSectionBuilder';
import type { ProfileSample } from '../src/render/measure/profileSampler';
import type { ProfileView, ProfileViewport } from '../src/render/measure/profileViewTransform';

/** One recorded call, with the context state that was in force for it. */
interface Op {
  readonly op: string;
  readonly args: readonly number[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly globalAlpha: number;
  readonly lineWidth: number;
}

/**
 * A `CanvasRenderingContext2D` stand-in that records instead of drawing.
 *
 * It offers nothing but the drawing calls, so a renderer that tried to build
 * a DOM node or an SVG element per return would have nowhere to build it and
 * would throw in the Node environment these tests run in.
 */
class RecordingContext implements ProfileRenderingContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  readonly ops: Op[] = [];

  private record(op: string, args: number[]): void {
    this.ops.push({
      op,
      args,
      fillStyle: String(this.fillStyle),
      strokeStyle: String(this.strokeStyle),
      globalAlpha: this.globalAlpha,
      lineWidth: this.lineWidth,
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

  of(op: string): Op[] {
    return this.ops.filter((o) => o.op === op);
  }
  names(): string[] {
    return this.ops.map((o) => o.op);
  }
}

class RecordingSurface implements ProfileSurface {
  readonly ctx = new RecordingContext();
  readonly sizes: Array<[number, number]> = [];
  setBackingSize(deviceWidth: number, deviceHeight: number): void {
    this.sizes.push([deviceWidth, deviceHeight]);
  }
}

/** A scheduler whose frames only run when the test says so. */
class ManualScheduler {
  readonly queue: Array<() => void> = [];
  readonly schedule = (draw: () => void): void => {
    this.queue.push(draw);
  };
  flush(): number {
    const pending = this.queue.splice(0, this.queue.length);
    for (const fn of pending) fn();
    return pending.length;
  }
}

const VIEWPORT: ProfileViewport = { width: 800, height: 400, devicePixelRatio: 2 };

const VIEW: ProfileView = {
  centreChainage: 50,
  centreHeight: 10,
  pxPerChainage: 4,
  pxPerHeight: 8,
};

const STYLE: ProfileSectionStyle = {
  pointSizePx: 3,
  pointAlpha: 1,
  stationWidthPx: 1.5,
  stationColour: 'rgb(20, 30, 40)',
  stationAlpha: 0.5,
};

/**
 * The transform, written out independently.
 *
 * Screen x grows with chainage; screen y is negated because height grows
 * upward while canvas y grows downward.
 */
function expectedScreen(
  view: ProfileView,
  viewport: ProfileViewport,
  chainage: number,
  height: number,
): [number, number] {
  return [
    viewport.width / 2 + (chainage - view.centreChainage) * view.pxPerChainage,
    viewport.height / 2 - (height - view.centreHeight) * view.pxPerHeight,
  ];
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

function scene(
  points: ProfileSectionPoints,
  indices: number[],
  colours: number[],
  stations?: ProfileSample[] | null,
): ProfileSectionScene {
  return {
    points,
    indices: Uint32Array.from(indices),
    colours: Uint8Array.from(colours),
    stations: stations ?? null,
  };
}

function frameOf(
  s: ProfileSectionScene,
  view: ProfileView = VIEW,
  viewport: ProfileViewport = VIEWPORT,
  style: ProfileSectionStyle = STYLE,
): ProfileSectionFrame {
  return { scene: s, view, viewport, style };
}

function renderOnce(frame: ProfileSectionFrame): RecordingSurface {
  const surface = new RecordingSurface();
  const scheduler = new ManualScheduler();
  const renderer = new ProfileSectionRenderer(surface, scheduler.schedule);
  renderer.setFrame(frame);
  renderer.renderNow();
  return surface;
}

describe('ProfileSectionRenderer — observed returns', () => {
  it('draws exactly the given indices, at the positions the transform defines', () => {
    // Five returns, three of them drawn, deliberately out of order so a
    // renderer that walked the point array instead of the index list is
    // caught by both the count and the positions.
    const points = makePoints([0, 10, 20, 30, 40], [1, 2, 3, 4, 5]);
    const indices = [3, 0, 2];
    const colours = [10, 11, 12, 20, 21, 22, 30, 31, 32];
    const surface = renderOnce(frameOf(scene(points, indices, colours)));

    const fills = surface.ctx.of('fillRect');
    expect(fills).toHaveLength(indices.length);

    const size = STYLE.pointSizePx;
    indices.forEach((i, k) => {
      const [x, y] = expectedScreen(
        VIEW,
        VIEWPORT,
        Math.fround(points.chainage[i]!),
        points.height[i]!,
      );
      expect(fills[k]!.args).toEqual([x - size / 2, y - size / 2, size, size]);
    });

    // Spot-check one of them against arithmetic done by hand, so the helper
    // itself cannot drift unnoticed: index 3 is chainage 30, height 4.
    // x = 400 + (30 - 50) * 4 = 320 ; y = 200 - (4 - 10) * 8 = 248.
    expect(fills[0]!.args).toEqual([320 - 1.5, 248 - 1.5, 3, 3]);
  });

  it('pairs each drawn index with the colour triplet at its own position', () => {
    const points = makePoints([0, 10, 20], [0, 0, 0]);
    // Index list is not the identity, so pairing by index rather than by
    // position gives different colours for every entry.
    const indices = [2, 0, 1];
    const colours = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const surface = renderOnce(frameOf(scene(points, indices, colours)));

    const fills = surface.ctx.of('fillRect');
    expect(fills.map((f) => f.fillStyle)).toEqual([
      'rgb(1, 2, 3)',
      'rgb(4, 5, 6)',
      'rgb(7, 8, 9)',
    ]);
  });

  it('assigns fillStyle only when the colour changes', () => {
    const points = makePoints([0, 10, 20, 30], [0, 0, 0, 0]);
    const colours = [5, 5, 5, 5, 5, 5, 9, 9, 9, 9, 9, 9];
    const surface = renderOnce(frameOf(scene(points, [0, 1, 2, 3], colours)));
    const fills = surface.ctx.of('fillRect');
    expect(fills.map((f) => f.fillStyle)).toEqual([
      'rgb(5, 5, 5)',
      'rgb(5, 5, 5)',
      'rgb(9, 9, 9)',
      'rgb(9, 9, 9)',
    ]);
  });

  it('truncates rather than reading past a colour array shorter than the index list', () => {
    const points = makePoints([0, 10, 20], [0, 0, 0]);
    const surface = renderOnce(frameOf(scene(points, [0, 1, 2], [1, 2, 3, 4, 5, 6])));
    expect(surface.ctx.of('fillRect')).toHaveLength(2);
  });

  it('skips an index that is out of range for the section', () => {
    const points = makePoints([0, 10], [0, 0]);
    const surface = renderOnce(frameOf(scene(points, [0, 7], [1, 1, 1, 2, 2, 2])));
    expect(surface.ctx.of('fillRect')).toHaveLength(1);
  });

  it('creates no per-return DOM: only 2D drawing calls are ever issued', () => {
    expect(typeof document).toBe('undefined');
    const points = makePoints([0, 10, 20], [1, 2, 3]);
    const stations: ProfileSample[] = [
      { distance: 0, height: 1 },
      { distance: 10, height: 2 },
    ];
    const surface = renderOnce(
      frameOf(scene(points, [0, 1, 2], [1, 1, 1, 2, 2, 2, 3, 3, 3], stations)),
    );
    const allowed = new Set([
      'setTransform',
      'clearRect',
      'fillRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
    ]);
    expect(surface.ctx.names().every((n) => allowed.has(n))).toBe(true);
    expect(surface.ctx.ops.length).toBeGreaterThan(0);
  });
});

describe('ProfileSectionRenderer — device pixel ratio', () => {
  it('sizes the backing store in device pixels and scales the transform by the ratio', () => {
    const points = makePoints([50], [10]);
    const surface = renderOnce(frameOf(scene(points, [0], [255, 0, 0])));

    // 800 x 400 CSS at DPR 2.
    expect(surface.sizes).toEqual([[1600, 800]]);
    const transform = surface.ctx.of('setTransform');
    expect(transform).toHaveLength(1);
    expect(transform[0]!.args).toEqual([2, 0, 0, 2, 0, 0]);
    // The clear is in CSS pixels, because the transform already carries DPR.
    expect(surface.ctx.of('clearRect')[0]!.args).toEqual([0, 0, 800, 400]);
  });

  it('keeps CSS-pixel geometry identical across ratios while the backing store changes', () => {
    const points = makePoints([20, 60], [4, 16]);
    const s = scene(points, [0, 1], [1, 1, 1, 2, 2, 2]);
    const at1 = renderOnce(frameOf(s, VIEW, { width: 800, height: 400, devicePixelRatio: 1 }));
    const at3 = renderOnce(frameOf(s, VIEW, { width: 800, height: 400, devicePixelRatio: 3 }));

    expect(at1.sizes).toEqual([[800, 400]]);
    expect(at3.sizes).toEqual([[2400, 1200]]);
    expect(at1.ctx.of('setTransform')[0]!.args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(at3.ctx.of('setTransform')[0]!.args).toEqual([3, 0, 0, 3, 0, 0]);
    expect(at3.ctx.of('fillRect').map((f) => f.args)).toEqual(
      at1.ctx.of('fillRect').map((f) => f.args),
    );
  });

  it('falls back to a ratio of one when the reported ratio is not usable', () => {
    const points = makePoints([50], [10]);
    const surface = renderOnce(
      frameOf(scene(points, [0], [1, 1, 1]), VIEW, {
        width: 800,
        height: 400,
        devicePixelRatio: Number.NaN,
      }),
    );
    expect(surface.sizes).toEqual([[800, 400]]);
    expect(surface.ctx.of('setTransform')[0]!.args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('resizes the backing store only when the device size actually changes', () => {
    const surface = new RecordingSurface();
    const scheduler = new ManualScheduler();
    const renderer = new ProfileSectionRenderer(surface, scheduler.schedule);
    const points = makePoints([50], [10]);
    renderer.setFrame(frameOf(scene(points, [0], [1, 1, 1])));
    renderer.renderNow();
    renderer.renderNow();
    expect(surface.sizes).toHaveLength(1);

    renderer.setFrame(
      frameOf(scene(points, [0], [1, 1, 1]), VIEW, {
        width: 800,
        height: 400,
        devicePixelRatio: 1,
      }),
    );
    renderer.renderNow();
    expect(surface.sizes).toEqual([
      [1600, 800],
      [800, 400],
    ]);
  });
});

describe('ProfileSectionRenderer — derived station overlay', () => {
  const points = makePoints([0], [10]);
  const oneReturn = [0];
  const oneColour = [255, 255, 255];

  it('draws straight segments between adjacent samples', () => {
    const stations: ProfileSample[] = [
      { distance: 0, height: 4, count: 9 },
      { distance: 25, height: 8, count: 7 },
      { distance: 50, height: 6, count: 5 },
    ];
    const surface = renderOnce(
      frameOf(scene(points, oneReturn, oneColour, stations)),
    );

    expect(surface.ctx.of('stroke')).toHaveLength(1);
    expect(surface.ctx.of('beginPath')).toHaveLength(1);
    const moves = surface.ctx.of('moveTo');
    const lines = surface.ctx.of('lineTo');
    expect(moves).toHaveLength(1);
    expect(lines).toHaveLength(2);
    expect(moves[0]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 0, 4));
    expect(lines[0]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 25, 8));
    expect(lines[1]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 50, 6));
  });

  it('breaks the run at a NaN height instead of interpolating across it', () => {
    const stations: ProfileSample[] = [
      { distance: 0, height: 4, count: 3 },
      { distance: 10, height: 5, count: 2 },
      { distance: 20, height: Number.NaN, count: 0 },
      { distance: 30, height: 7, count: 4 },
      { distance: 40, height: 8, count: 6 },
    ];
    const surface = renderOnce(frameOf(scene(points, oneReturn, oneColour, stations)));

    // Two runs, not one path.
    expect(surface.ctx.of('stroke')).toHaveLength(2);
    expect(surface.ctx.of('beginPath')).toHaveLength(2);
    const moves = surface.ctx.of('moveTo');
    expect(moves).toHaveLength(2);
    expect(moves[0]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 0, 4));
    expect(moves[1]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 30, 7));

    // No segment spans the gap: the only lineTo endpoints are the second
    // sample of each run, and none of them is reached from across the gap.
    const lines = surface.ctx.of('lineTo');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 10, 5));
    expect(lines[1]!.args).toEqual(expectedScreen(VIEW, VIEWPORT, 40, 8));

    // The path structure, read in order, is two closed-off runs.
    const path = surface.ctx.names().filter((n) => n !== 'fillRect');
    expect(path).toEqual([
      'setTransform',
      'clearRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
      'beginPath',
      'moveTo',
      'lineTo',
      'stroke',
    ]);
  });

  it('leaves an isolated station between two gaps unstroked', () => {
    const stations: ProfileSample[] = [
      { distance: 0, height: Number.NaN, count: 0 },
      { distance: 10, height: 5, count: 1 },
      { distance: 20, height: Number.NaN, count: 0 },
    ];
    const surface = renderOnce(frameOf(scene(points, oneReturn, oneColour, stations)));
    expect(surface.ctx.of('stroke')).toHaveLength(0);
    expect(surface.ctx.of('lineTo')).toHaveLength(0);
  });

  it('draws nothing extra when no station series is supplied', () => {
    const surface = renderOnce(frameOf(scene(points, oneReturn, oneColour, null)));
    expect(surface.ctx.of('stroke')).toHaveLength(0);
    expect(surface.ctx.of('beginPath')).toHaveLength(0);
  });

  it('draws the derived overlay after every observed return', () => {
    const many = makePoints([0, 10, 20, 30], [1, 2, 3, 4]);
    const stations: ProfileSample[] = [
      { distance: 0, height: 4 },
      { distance: 30, height: 6 },
    ];
    const surface = renderOnce(
      frameOf(
        scene(many, [0, 1, 2, 3], [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], stations),
      ),
    );
    const names = surface.ctx.names();
    const lastFill = names.lastIndexOf('fillRect');
    const firstPath = names.indexOf('beginPath');
    expect(lastFill).toBeGreaterThanOrEqual(0);
    expect(firstPath).toBeGreaterThanOrEqual(0);
    expect(lastFill).toBeLessThan(firstPath);
    expect(names.indexOf('stroke')).toBeGreaterThan(lastFill);
  });

  it('keeps the derived overlay subordinate to the returns it came from', () => {
    const stations: ProfileSample[] = [
      { distance: 0, height: 4 },
      { distance: 30, height: 6 },
    ];
    const loud: ProfileSectionStyle = { ...STYLE, stationAlpha: 1 };
    const surface = renderOnce(
      frameOf(scene(points, oneReturn, oneColour, stations), VIEW, VIEWPORT, loud),
    );
    const strokes = surface.ctx.of('stroke');
    const fills = surface.ctx.of('fillRect');
    expect(strokes[0]!.globalAlpha).toBe(MAX_STATION_ALPHA);
    expect(strokes[0]!.globalAlpha).toBeLessThan(fills[0]!.globalAlpha);
    expect(strokes[0]!.strokeStyle).toBe(STYLE.stationColour);
    expect(strokes[0]!.lineWidth).toBe(STYLE.stationWidthPx);
  });
});

describe('ProfileSectionRenderer — coalescing', () => {
  it('turns several invalidations in one frame into a single draw', () => {
    const surface = new RecordingSurface();
    const scheduler = new ManualScheduler();
    const renderer = new ProfileSectionRenderer(surface, scheduler.schedule);
    renderer.setFrame(frameOf(scene(makePoints([0], [0]), [0], [1, 1, 1])));

    renderer.requestRender();
    renderer.requestRender();
    renderer.requestRender();
    expect(scheduler.queue).toHaveLength(1);
    expect(renderer.pending).toBe(true);
    expect(renderer.drawCount).toBe(0);

    expect(scheduler.flush()).toBe(1);
    expect(renderer.drawCount).toBe(1);
    expect(renderer.pending).toBe(false);
    expect(surface.ctx.of('clearRect')).toHaveLength(1);
  });

  it('accepts a fresh invalidation after the frame has run', () => {
    const surface = new RecordingSurface();
    const scheduler = new ManualScheduler();
    const renderer = new ProfileSectionRenderer(surface, scheduler.schedule);
    renderer.setFrame(frameOf(scene(makePoints([0], [0]), [0], [1, 1, 1])));

    renderer.requestRender();
    scheduler.flush();
    renderer.requestRender();
    renderer.requestRender();
    expect(scheduler.queue).toHaveLength(1);
    scheduler.flush();
    expect(renderer.drawCount).toBe(2);
  });

  it('schedules one more frame when an invalidation is raised during a draw', () => {
    const surface = new RecordingSurface();
    const scheduler = new ManualScheduler();
    const renderer = new ProfileSectionRenderer(surface, scheduler.schedule);
    renderer.setFrame(frameOf(scene(makePoints([0], [0]), [0], [1, 1, 1])));

    let reentered = false;
    const originalSetBackingSize = surface.setBackingSize.bind(surface);
    surface.setBackingSize = (w: number, h: number): void => {
      originalSetBackingSize(w, h);
      if (!reentered) {
        reentered = true;
        renderer.requestRender();
      }
    };

    renderer.requestRender();
    scheduler.flush();
    expect(renderer.drawCount).toBe(1);
    expect(scheduler.queue).toHaveLength(1);
    scheduler.flush();
    expect(renderer.drawCount).toBe(2);
  });

  it('draws nothing before a frame has been set', () => {
    const surface = new RecordingSurface();
    const scheduler = new ManualScheduler();
    const renderer = new ProfileSectionRenderer(surface, scheduler.schedule);
    renderer.renderNow();
    expect(surface.ctx.ops).toHaveLength(0);
    expect(renderer.drawCount).toBe(0);
  });
});

describe('ProfileSectionRenderer — non-finite input', () => {
  it('skips returns whose coordinates are not finite and keeps the rest', () => {
    const points = makePoints([0, Number.NaN, 20], [1, 2, Number.POSITIVE_INFINITY]);
    const surface = renderOnce(
      frameOf(scene(points, [0, 1, 2], [1, 1, 1, 2, 2, 2, 3, 3, 3])),
    );
    const fills = surface.ctx.of('fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.fillStyle).toBe('rgb(1, 1, 1)');
  });

  it('neither throws nor draws when the view scales are not finite', () => {
    const points = makePoints([0, 10, 20], [1, 2, 3]);
    const stations: ProfileSample[] = [
      { distance: 0, height: 1 },
      { distance: 10, height: 2 },
    ];
    const brokenView: ProfileView = {
      centreChainage: Number.NaN,
      centreHeight: 0,
      pxPerChainage: Number.POSITIVE_INFINITY,
      pxPerHeight: Number.NaN,
    };
    const surface = renderOnce(
      frameOf(scene(points, [0, 1, 2], [1, 1, 1, 2, 2, 2, 3, 3, 3], stations), brokenView),
    );
    expect(surface.ctx.of('fillRect')).toHaveLength(0);
    expect(surface.ctx.of('stroke')).toHaveLength(0);
    // The frame still completes: the surface was sized and cleared.
    expect(surface.ctx.of('clearRect')).toHaveLength(1);
  });

  it('survives a viewport whose size is not usable', () => {
    const points = makePoints([0], [0]);
    const surface = renderOnce(
      frameOf(scene(points, [0], [1, 1, 1]), VIEW, {
        width: Number.NaN,
        height: -5,
        devicePixelRatio: 2,
      }),
    );
    expect(surface.sizes).toEqual([[2, 2]]);
    expect(surface.ctx.of('clearRect')[0]!.args).toEqual([0, 0, 1, 1]);
  });

  it('clamps an unusable splat size rather than drawing an unbounded rectangle', () => {
    const points = makePoints([50, 50], [10, 10]);
    const bad: ProfileSectionStyle = { ...STYLE, pointSizePx: Number.NaN };
    const huge: ProfileSectionStyle = { ...STYLE, pointSizePx: 1e9 };
    const a = renderOnce(frameOf(scene(points, [0], [1, 1, 1]), VIEW, VIEWPORT, bad));
    const b = renderOnce(frameOf(scene(points, [0], [1, 1, 1]), VIEW, VIEWPORT, huge));
    expect(a.ctx.of('fillRect')[0]!.args[2]).toBe(1);
    expect(b.ctx.of('fillRect')[0]!.args[2]).toBe(64);
  });

  it('terminates on a large index list', () => {
    const n = 20000;
    const chainage: number[] = [];
    const height: number[] = [];
    for (let i = 0; i < n; i++) {
      chainage.push(i * 0.01);
      height.push((i % 17) * 0.5);
    }
    const points = makePoints(chainage, height);
    const indices: number[] = [];
    const colours: number[] = [];
    for (let i = 0; i < n; i++) {
      indices.push(i);
      colours.push(i & 255, (i >> 3) & 255, (i >> 6) & 255);
    }
    const surface = renderOnce(frameOf(scene(points, indices, colours)));
    expect(surface.ctx.of('fillRect')).toHaveLength(n);
  });
});
