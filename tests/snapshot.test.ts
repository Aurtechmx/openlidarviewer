/**
 * The snapshot pipeline's option-resolution, fast-path and error contract.
 *
 * These behaviours previously lived inline in `Viewer.snapshot` and could only
 * be exercised through a real WebGL Viewer (browser / e2e). Extracting the
 * pipeline to take a structural host makes the parts that DON'T need a canvas
 * context — how options map to the capture plan, when the untouched GL canvas
 * is returned, and how `toBlob === null` is surfaced — directly testable with a
 * fake host, mirroring `tests/exportAdapter.test.ts`.
 *
 * The composite (overlay-compositing) path needs a real 2-D canvas + DOM and
 * stays covered by the e2e export suite; the node environment here deliberately
 * lacks `document`, so every case below is one the fast path or the pure helpers
 * fully own.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  captureSnapshot,
  colorbarBurnInNotes,
  canvasToBlob,
  backgroundCss,
  renderedCopy,
  underlayOpaque,
  resolveSnapshotPlan,
  fastPathEligible,
  type SnapshotHost,
  type SnapshotPlan,
} from '../src/render/snapshot';
import type { ActiveColorbar } from '../src/render/activeColorbar';

/** A fake GL canvas — only the fields the fast path reads. */
function fakeCanvas(blob: Blob | null = new Blob(['png'])): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    toBlob: (cb: BlobCallback) => cb(blob),
  } as unknown as HTMLCanvasElement;
}

/** A host wired to defaults that keep every capture on the fast path. */
function host(over: Partial<SnapshotHost> = {}): SnapshotHost {
  return {
    ready: vi.fn(async () => {}),
    renderFrame: vi.fn(),
    glCanvas: vi.fn(() => fakeCanvas()),
    background: vi.fn(() => null),
    activeColorbar: vi.fn(() => null),
    measurementsOverlaySVG: vi.fn(() => '<svg/>'),
    annotationsOverlaySVG: vi.fn(() => '<svg/>'),
    inspectorOverlaySVG: vi.fn(() => '<svg/>'),
    inspectorSelection: vi.fn(() => null),
    probeReadout: vi.fn(() => null),
    canvasRect: vi.fn(() => ({ left: 0, top: 0, width: 800, height: 600 })),
    scaleBarCamera: vi.fn(() => ({ distanceToTarget: 10, fovYRadians: 1 })),
    ...over,
  };
}

/** A minimal continuous-colour legend spec, enough to defeat the fast path. */
const someColorbar = { spec: { min: 0, max: 1 }, note: null } as unknown as ActiveColorbar;

describe('resolveSnapshotPlan — option → plan mapping', () => {
  it('defaults to all-off, native resolution when no options are given', () => {
    expect(resolveSnapshotPlan()).toEqual({
      wantAnnotations: false,
      wantMeasurements: false,
      wantInspector: false,
      wantProbe: false,
      wantScaleBar: false,
      wantColorbar: false,
      supersample: 1,
    } satisfies SnapshotPlan);
  });

  it('maps each boolean layer flag through verbatim', () => {
    const plan = resolveSnapshotPlan({
      annotations: true,
      measurements: true,
      inspector: true,
      probe: true,
      scaleBar: true,
      colorbar: true,
    });
    expect(plan.wantAnnotations).toBe(true);
    expect(plan.wantMeasurements).toBe(true);
    expect(plan.wantInspector).toBe(true);
    expect(plan.wantProbe).toBe(true);
    expect(plan.wantScaleBar).toBe(true);
    expect(plan.wantColorbar).toBe(true);
  });

  it('only accepts 2 or 4 as a supersample promotion; everything else stays 1', () => {
    // The clamp is what keeps a bad caller value (or the native default) from
    // silently upscaling the output canvas to a wrong size.
    expect(resolveSnapshotPlan({ supersample: 2 }).supersample).toBe(2);
    expect(resolveSnapshotPlan({ supersample: 4 }).supersample).toBe(4);
    expect(resolveSnapshotPlan({ supersample: 1 }).supersample).toBe(1);
    expect(resolveSnapshotPlan({ supersample: 3 as 1 | 2 | 4 }).supersample).toBe(1);
    expect(resolveSnapshotPlan({}).supersample).toBe(1);
  });
});

describe('fastPathEligible — when the untouched GL canvas can be returned', () => {
  const bare = resolveSnapshotPlan();

  it('is eligible with no overlays, no upscale, no scale bar and no colorbar', () => {
    expect(fastPathEligible(bare, null)).toBe(true);
  });

  it('is defeated by any single overlay flag', () => {
    for (const opt of [
      { annotations: true },
      { measurements: true },
      { inspector: true },
      { probe: true },
      { scaleBar: true },
    ]) {
      expect(fastPathEligible(resolveSnapshotPlan(opt), null)).toBe(false);
    }
  });

  it('is defeated by a supersample promotion', () => {
    expect(fastPathEligible(resolveSnapshotPlan({ supersample: 2 }), null)).toBe(false);
  });

  it('is defeated by a resolved (non-null) colorbar, but NOT by a null one', () => {
    // colorbar:true with a categorical mode yields a null spec, so the caller
    // can request it unconditionally and still take the fast path.
    expect(fastPathEligible(bare, someColorbar)).toBe(false);
    expect(fastPathEligible(bare, null)).toBe(true);
  });
});

describe('canvasToBlob — PNG encode + null rejection', () => {
  it('resolves with the blob the browser hands back', async () => {
    const blob = new Blob(['png']);
    await expect(canvasToBlob(fakeCanvas(blob))).resolves.toBe(blob);
  });

  it('rejects with the stable message when toBlob returns null', async () => {
    await expect(canvasToBlob(fakeCanvas(null))).rejects.toThrow(
      'Viewer.snapshot(): canvas.toBlob returned null',
    );
  });
});

describe('captureSnapshot — fast path', () => {
  it('awaits ready, renders two present frames, then returns the untouched GL blob', async () => {
    const blob = new Blob(['native']);
    const h = host({ glCanvas: () => fakeCanvas(blob) });
    const result = await captureSnapshot(h);
    expect(result).toBe(blob);
    expect(h.ready).toHaveBeenCalledTimes(1);
    // Two render()/present cycles flush the WebGPU colour-buffer upload — the
    // fix for every export mode reading the previous frame — and a third render
    // runs in the same task as the read.
    expect(h.renderFrame).toHaveBeenCalledTimes(3);
  });

  it('copies the canvas in the same task as the last render, with nothing awaited between', async () => {
    const order: string[] = [];
    const out = {
      width: 0, height: 0,
      getContext: () => ({
        drawImage: () => order.push('drawImage'),
        save: () => {}, restore: () => {}, fillRect: () => {},
      }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['copy'])),
    };
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: () => out };
    try {
      let afterRender = false;
      const h = host({
        renderFrame: vi.fn(() => {
          order.push('render');
          afterRender = true;
          // A microtask between the render and the read would flip this first.
          void Promise.resolve().then(() => { if (afterRender) order.push('microtask'); afterRender = false; });
        }),
      });
      await captureSnapshot(h);
      const last = order.lastIndexOf('render');
      expect(order[last + 1]).toBe('drawImage');
    } finally {
      g.document = prev;
    }
  });

  it('does not touch any overlay accessor or the colorbar on the fast path', async () => {
    const h = host();
    await captureSnapshot(h);
    expect(h.measurementsOverlaySVG).not.toHaveBeenCalled();
    expect(h.annotationsOverlaySVG).not.toHaveBeenCalled();
    expect(h.inspectorOverlaySVG).not.toHaveBeenCalled();
    expect(h.probeReadout).not.toHaveBeenCalled();
    // colorbar off ⇒ activeColorbar is never even consulted.
    expect(h.activeColorbar).not.toHaveBeenCalled();
  });

  it('consults activeColorbar only when colorbar is requested, and stays fast when it is null', async () => {
    const h = host({ activeColorbar: vi.fn(() => null) });
    const blob = new Blob(['native']);
    (h.glCanvas as ReturnType<typeof vi.fn>).mockReturnValue(fakeCanvas(blob));
    const result = await captureSnapshot(h, { colorbar: true });
    expect(h.activeColorbar).toHaveBeenCalledTimes(1);
    // A categorical mode (null spec) keeps the fast path: the GL blob is
    // returned without ever building a 2-D output canvas.
    expect(result).toBe(blob);
  });

  it('propagates the toBlob-null rejection through the fast path', async () => {
    const h = host({ glCanvas: () => fakeCanvas(null) });
    await expect(captureSnapshot(h)).rejects.toThrow(
      'Viewer.snapshot(): canvas.toBlob returned null',
    );
  });
});

describe('colorbarBurnInNotes — the lines under the burned-in colour bar', () => {
  const bar = (mode: string, note?: string): ActiveColorbar =>
    ({ mode, spec: { min: 0, max: 1 }, note } as unknown as ActiveColorbar);

  it('keeps the window note and adds the derived-colour line for a non-RGB mode', () => {
    expect(colorbarBurnInNotes(bar('elevation', 'p5–p95 window'))).toEqual([
      'p5–p95 window',
      'Colour is applied by the viewer, not recorded by the scan.',
    ]);
  });

  it('emits the derived-colour line alone when there is no window note', () => {
    expect(colorbarBurnInNotes(bar('intensity'))).toEqual([
      'Colour is applied by the viewer, not recorded by the scan.',
    ]);
  });

  it('adds nothing for measured (RGB) colour', () => {
    expect(colorbarBurnInNotes(bar('rgb', 'p5–p95 window'))).toEqual(['p5–p95 window']);
  });
});

describe('opaque frame copy', () => {
  /** A 2-D context that records its calls and keeps the composite mode. */
  function recordingContext(log: string[]) {
    const saved: Array<[GlobalCompositeOperation, string]> = [];
    const ctx = {
      globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
      fillStyle: '#fff' as string | CanvasGradient | CanvasPattern,
      save: () => { saved.push([ctx.globalCompositeOperation, String(ctx.fillStyle)]); log.push('save'); },
      restore: () => {
        const [op, fill] = saved.pop() as [GlobalCompositeOperation, string];
        ctx.globalCompositeOperation = op;
        ctx.fillStyle = fill;
        log.push('restore');
      },
      fillRect: (x: number, y: number, w: number, h: number) => {
        log.push(`fillRect ${x},${y},${w},${h} ${ctx.globalCompositeOperation} ${String(ctx.fillStyle)}`);
      },
      drawImage: () => log.push('drawImage'),
    };
    return ctx;
  }

  const sceneColour = { getStyle: () => 'rgb(7,11,22)' };

  it('paints the scene background under the full copy after drawing the frame', () => {
    const log: string[] = [];
    const ctx = recordingContext(log);
    const out = { width: 0, height: 0, getContext: () => ctx };
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: () => out };
    try {
      const copy = renderedCopy({ width: 8, height: 4 } as HTMLCanvasElement, () => log.push('render'), 8, 4, sceneColour);
      expect(copy).toBe(out);
      expect(log).toEqual(['render', 'drawImage', 'save', 'fillRect 0,0,8,4 destination-over rgb(7,11,22)', 'restore']);
      // The composite mode and fill the later overlays rely on are put back.
      expect(ctx.globalCompositeOperation).toBe('source-over');
      expect(ctx.fillStyle).toBe('#fff');
    } finally {
      g.document = prev;
    }
  });

  it('takes the background from the host on both the fast and the composite path', async () => {
    const seen: string[] = [];
    const out = {
      width: 0, height: 0,
      getContext: () => ({
        ...recordingContext([]),
        fillRect: function (this: { fillStyle: unknown }) { seen.push(String(this.fillStyle)); },
        drawImage: () => {},
      }),
      toBlob: (cb: (b: Blob | null) => void) => cb(new Blob(['copy'])),
    };
    const g = globalThis as unknown as { document?: unknown };
    const prev = g.document;
    g.document = { createElement: () => out };
    try {
      const h = host({ background: vi.fn(() => sceneColour), glCanvas: () => ({ width: 4, height: 4 }) as HTMLCanvasElement });
      await captureSnapshot(h);
      await captureSnapshot(h, { supersample: 2 }).catch(() => undefined);
      expect(seen.slice(0, 1)).toEqual(['rgb(7,11,22)']);
      expect(seen.every((c) => c === 'rgb(7,11,22)')).toBe(true);
      expect(seen.length).toBeGreaterThanOrEqual(2);
    } finally {
      g.document = prev;
    }
  });

  it('reads the background as a CSS colour, with black for a texture or nothing', () => {
    expect(backgroundCss(sceneColour)).toBe('rgb(7,11,22)');
    expect(backgroundCss(null)).toBe('#000');
    expect(backgroundCss(undefined)).toBe('#000');
    expect(backgroundCss({ isTexture: true })).toBe('#000');
  });

  it('leaves an opaque pixel unchanged and makes a partly transparent one opaque', () => {
    /** One premultiplied pixel that applies destination-over to a fill. */
    const pixelCtx = (px: number[]) => {
      const ctx = {
        globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
        fillStyle: '' as string | CanvasGradient | CanvasPattern,
        save: () => {},
        restore: () => {},
        fillRect: () => {
          if (ctx.globalCompositeOperation !== 'destination-over') return;
          const under = [7, 11, 22, 255];
          const k = 1 - px[3] / 255;
          for (let i = 0; i < 4; i++) px[i] = Math.round(px[i] + under[i] * k);
        },
      };
      return ctx;
    };
    const opaque = [200, 120, 40, 255];
    underlayOpaque(pixelCtx(opaque), 1, 1, 'rgb(7,11,22)');
    expect(opaque).toEqual([200, 120, 40, 255]);
    const edge = [60, 30, 10, 128];
    underlayOpaque(pixelCtx(edge), 1, 1, 'rgb(7,11,22)');
    expect(edge[3]).toBe(255);
    expect(edge.slice(0, 3)).toEqual([63, 35, 21]);
  });
});
