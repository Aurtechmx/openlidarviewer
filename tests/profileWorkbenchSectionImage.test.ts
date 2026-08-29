/**
 * profileWorkbenchSectionImage.test.ts
 *
 * The wiring that turns a live workbench section into a PNG export. The compose
 * itself is covered by profileSectionImage.test.ts; what is under test here is
 * the join:
 *
 *   the request the builder assembles carries the TRUE accepted count (every
 *   accepted return), the drawn indices, and the colours resolved for them, so
 *   the drawn ≤ accepted honesty the compose enforces is preserved through the
 *   wiring rather than defeated by feeding it the display cap;
 *
 *   the scope and streaming completeness are threaded from the section, not
 *   re-derived;
 *
 *   the export composes onto a real 2D context, encodes a PNG, and downloads it
 *   deterministically — the same section produces the same draw twice.
 *
 * No jsdom: the canvas is a recording double, which is also what proves the
 * export path never reaches for a DOM the compose forbids.
 */

import { describe, it, expect } from 'vitest';
import {
  buildProfileSectionImageRequest,
  exportProfileSectionImagePng,
  prepareWorkbenchSection,
  type SectionImageCanvas,
  type WorkbenchCanvas,
  type WorkbenchSectionPlot,
} from '../src/app/profileWorkbenchSection';
import { composeProfileSectionImage } from '../src/render/measure/profileSectionImage';
import type {
  ProfileImageContext,
  ProfileImageSurface,
} from '../src/render/measure/profileSectionImage';
import type { ProfileSectionResult } from '../src/render/measure/profileSectionSeam';
import type { ProfileSectionPoints } from '../src/render/measure/profileSectionBuilder';
import type { ProfileViewport } from '../src/render/measure/profileViewTransform';

// ─────────────────────────────────────────────────────────────────────────────
// Recording canvas
// ─────────────────────────────────────────────────────────────────────────────

class RecordingContext implements ProfileImageContext {
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  globalAlpha = 1;
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  readonly ops: string[] = [];
  private rec(op: string): void {
    this.ops.push(op);
  }
  setTransform(): void {
    this.rec('setTransform');
  }
  clearRect(): void {
    this.rec('clearRect');
  }
  fillRect(): void {
    this.rec('fillRect');
  }
  beginPath(): void {
    this.rec('beginPath');
  }
  moveTo(): void {
    this.rec('moveTo');
  }
  lineTo(): void {
    this.rec('lineTo');
  }
  stroke(): void {
    this.rec('stroke');
  }
  fillText(): void {
    this.rec('fillText');
  }
  save(): void {
    this.rec('save');
  }
  restore(): void {
    this.rec('restore');
  }
  translate(): void {
    this.rec('translate');
  }
  rotate(): void {
    this.rec('rotate');
  }
  rect(): void {
    this.rec('rect');
  }
  clip(): void {
    this.rec('clip');
  }
}

class RecordingCanvas implements SectionImageCanvas {
  width = 0;
  height = 0;
  readonly ctx = new RecordingContext();
  getContext(): ProfileImageSurface['ctx'] | null {
    return this.ctx;
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    callback(new Blob([`png:${this.ctx.ops.length}`], { type: 'image/png' }));
  }
}

/** A canvas whose 2D context is unavailable, as an older engine may report. */
class NoContextCanvas implements SectionImageCanvas {
  width = 0;
  height = 0;
  getContext(): ProfileImageSurface['ctx'] | null {
    return null;
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    callback(null);
  }
}

/** A canvas with a working context whose PNG encode fails (`toBlob` → null). */
class EncodeFailsCanvas implements SectionImageCanvas {
  width = 0;
  height = 0;
  readonly ctx = new RecordingContext();
  getContext(): ProfileImageSurface['ctx'] | null {
    return this.ctx;
  }
  toBlob(callback: (blob: Blob | null) => void): void {
    callback(null);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SIZE: ProfileViewport = { width: 800, height: 500, devicePixelRatio: 2 };

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

/** A section carrying the fields the builder and the workbench read. */
function makeSection(count: number): ProfileSectionResult {
  const chainage = Array.from({ length: count }, (_, i) => i * 5);
  const height = Array.from({ length: count }, (_, i) => 10 + (i % 4) * 0.3);
  return {
    points: makePoints(chainage, height),
    frame: { origin: [0, 0, 0] } as unknown as ProfileSectionResult['frame'],
    band: 2,
    scope: 'resident-snapshot',
    scopeLabel: 'Resident snapshot, coverage unknown',
    classificationOnEverySource: true,
    streamingComplete: null,
    sources: [],
    generation: 1,
    aborted: false,
    skippedSlots: [],
    examined: count,
  };
}

/** A workbench canvas whose 2D context is absent — the plot still composes its
 *  request from the section state it captured. */
function nullContextCanvas(): WorkbenchCanvas {
  return {
    width: 0,
    height: 0,
    clientWidth: 0,
    clientHeight: 0,
    getContext: () => null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder assembles from live state
// ─────────────────────────────────────────────────────────────────────────────

describe('buildProfileSectionImageRequest — assembled from live section state', () => {
  it('carries the accepted total, the drawn indices, and the threaded scope', () => {
    const section = makeSection(6);
    const indices = Uint32Array.from([0, 1, 2, 3, 4, 5]);
    const colours = new Uint8Array(indices.length * 3);
    const surface: ProfileImageSurface = {
      ctx: new RecordingContext(),
      setBackingSize: () => {},
    };
    const request = buildProfileSectionImageRequest({
      surface,
      size: SIZE,
      section,
      indices,
      colours,
      bounds: { minChainage: 0, maxChainage: 25, minHeight: 10, maxHeight: 10.9 },
      reference: 'orthometric',
      unitSuffix: 'm',
      unitScale: 1,
      name: 'Section A',
      generatedAt: '2026-08-28 12:00 UTC',
    });

    // The accepted total is the section's own count, NOT the display cap.
    expect(request.acceptedCount).toBe(section.points.count);
    expect(request.scene.indices).toBe(indices);
    expect(request.scene.points).toBe(section.points);
    expect(request.scene.stations).toBeNull();
    expect(request.scope).toBe('resident-snapshot');
    expect(request.streamingComplete).toBeNull();
    // Unit stated only where the render unit already is that unit (scale 1).
    expect(request.axes.horizontalUnit).toBe('m');
  });

  it('drops the axis unit when the render scale is not 1', () => {
    const section = makeSection(4);
    const request = buildProfileSectionImageRequest({
      surface: { ctx: new RecordingContext(), setBackingSize: () => {} },
      size: SIZE,
      section,
      indices: Uint32Array.from([0, 1, 2, 3]),
      colours: new Uint8Array(12),
      bounds: { minChainage: 0, maxChainage: 15, minHeight: 10, maxHeight: 10.9 },
      reference: 'unknown',
      unitSuffix: 'm',
      unitScale: 0.3048,
      name: 'Section B',
      generatedAt: null,
    });
    expect(request.axes.horizontalUnit).toBeNull();
    expect(request.axes.verticalUnit).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Honesty preserved through the plot
// ─────────────────────────────────────────────────────────────────────────────

describe('prepareWorkbenchSection.imageRequest — drawn ≤ accepted', () => {
  it('builds a request whose drawn indices never exceed the accepted total', () => {
    const section = makeSection(9);
    const plot = prepareWorkbenchSection({
      section,
      canvas: nullContextCanvas(),
      unitSuffix: 'm',
      unitScale: 1,
    });
    const surface: ProfileImageSurface = { ctx: new RecordingContext(), setBackingSize: () => {} };
    const request = plot.imageRequest(surface, SIZE, { name: 'Live', generatedAt: null });

    expect(request.acceptedCount).toBe(section.points.count);
    expect(request.scene.indices.length).toBeLessThanOrEqual(request.acceptedCount);
    // The colours are one triplet per drawn index, as the renderer expects.
    expect(request.scene.colours.length).toBe(request.scene.indices.length * 3);

    // Composing the request discloses the two counts, and the drawn count is
    // counted from the draw, never taken as the accepted total.
    const result = composeProfileSectionImage(request);
    expect(result.acceptedCount).toBe(section.points.count);
    expect(result.drawnCount).toBeLessThanOrEqual(result.acceptedCount);
    expect(result.countsCaption).toContain('accepted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The export
// ─────────────────────────────────────────────────────────────────────────────

/** A minimal plot whose only live behaviour is the request it composes. */
function fakePlot(section: ProfileSectionResult): WorkbenchSectionPlot {
  const indices = Uint32Array.from(section.points.chainage.map((_, i) => i));
  const colours = new Uint8Array(indices.length * 3);
  return {
    view: {
      scope: section.scopeLabel,
      groundBasisNote: null,
      status: '',
      detail: [],
      drawn: indices.length,
    },
    indices,
    imageRequest: (surface, size, opts) =>
      buildProfileSectionImageRequest({
        surface,
        size,
        section,
        indices,
        colours,
        bounds: { minChainage: 0, maxChainage: 25, minHeight: 10, maxHeight: 10.9 },
        reference: 'orthometric',
        unitSuffix: 'm',
        unitScale: 1,
        name: opts.name,
        generatedAt: opts.generatedAt,
      }),
    draw: () => {},
    frame: () => null,
  };
}

describe('exportProfileSectionImagePng — composes, encodes, downloads', () => {
  it('renders onto a 2D context and hands a PNG to the download helper', async () => {
    const section = makeSection(6);
    const plot = fakePlot(section);
    let saved: { blob: Blob; filename: string } | null = null;
    const canvas = new RecordingCanvas();

    await exportProfileSectionImagePng(
      plot,
      { name: 'Section A/B', generatedAt: '2026-08-28 12:00 UTC', size: SIZE },
      { createCanvas: () => canvas, download: (blob, filename) => (saved = { blob, filename }) },
    );

    expect(saved).not.toBeNull();
    expect(saved!.filename).toBe('Section_A_B.png');
    expect(saved!.blob.type).toBe('image/png');
    // The compose actually drew onto the context: splats and text are present.
    expect(canvas.ctx.ops).toContain('fillRect');
    expect(canvas.ctx.ops).toContain('fillText');
    // The backing store was sized from the request, in device pixels.
    expect(canvas.width).toBe(SIZE.width * SIZE.devicePixelRatio);
  });

  it('is deterministic: the same section draws the same operations twice', async () => {
    const section = makeSection(7);
    const runOps = async (): Promise<string[]> => {
      const canvas = new RecordingCanvas();
      await exportProfileSectionImagePng(
        fakePlot(section),
        { name: 'S', generatedAt: '2026-08-28 12:00 UTC', size: SIZE },
        { createCanvas: () => canvas, download: () => {} },
      );
      return canvas.ctx.ops;
    };
    expect(await runOps()).toEqual(await runOps());
  });

  it('throws rather than appearing to save when no 2D context is available', async () => {
    await expect(
      exportProfileSectionImagePng(
        fakePlot(makeSection(4)),
        { name: 'S', generatedAt: null },
        { createCanvas: () => new NoContextCanvas(), download: () => {} },
      ),
    ).rejects.toThrow(/context/i);
  });

  it('throws, and downloads nothing, when the browser refuses to encode the PNG', async () => {
    let downloaded = false;
    await expect(
      exportProfileSectionImagePng(
        fakePlot(makeSection(5)),
        { name: 'S', generatedAt: null, size: SIZE },
        { createCanvas: () => new EncodeFailsCanvas(), download: () => (downloaded = true) },
      ),
    ).rejects.toThrow(/encode/i);
    expect(downloaded).toBe(false);
  });

  it('preserves a non-ASCII section name in the download filename', async () => {
    let filename: string | null = null;
    await exportProfileSectionImagePng(
      fakePlot(makeSection(5)),
      { name: 'Sección-Ñ 測線', generatedAt: null, size: SIZE },
      { createCanvas: () => new RecordingCanvas(), download: (_blob, name) => (filename = name) },
    );
    // Letters in any script ride through; only the space becomes a separator.
    expect(filename).toBe('Sección-Ñ_測線.png');
  });
});
