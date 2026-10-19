/**
 * The measurement overlay draws at most MAX_DRAWN_LABELS labels per frame, lays
 * them out against a spatial grid, and says when it left some out. The layout
 * result for an ordinary number of labels must not change.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  layoutLabels,
  selectLabelsToDraw,
  MAX_DRAWN_LABELS,
  type LabelBox,
  type PlacedLabel,
} from '../src/render/measure/labelLayout';
import { installFakeDom } from './support/measurePanelDom';

/** The linear scan the grid replaced, kept as the reference for equality. */
function layoutLabelsLinear(boxes: LabelBox[]): PlacedLabel[] {
  const GAP = 2;
  const order = boxes.map((_, i) => i).sort((a, b) => boxes[a].y - boxes[b].y);
  const placed = new Array<PlacedLabel>(boxes.length);
  const occupied: { top: number; bottom: number; x: number; halfW: number }[] = [];
  for (const i of order) {
    const box = boxes[i];
    const halfW = box.width / 2;
    const halfH = box.height / 2;
    let y = box.y;
    if (![box.x, box.y, halfW, halfH].every(Number.isFinite)) {
      placed[i] = { x: box.x, y, displaced: false };
      continue;
    }
    let moved = true;
    for (let pass = 0; moved && pass < 64; pass++) {
      moved = false;
      for (const o of occupied) {
        if (!(Math.abs(box.x - o.x) < halfW + o.halfW)) continue;
        if (y - halfH < o.bottom + GAP && y + halfH > o.top - GAP) {
          const next = o.bottom + GAP + halfH;
          if (next > y) {
            y = next;
            moved = true;
          }
        }
      }
    }
    occupied.push({ top: y - halfH, bottom: y + halfH, x: box.x, halfW });
    placed[i] = { x: box.x, y, displaced: Math.abs(y - box.y) > 6 };
  }
  return placed;
}

/** Deterministic pseudo-random numbers so a failure reproduces. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function scatter(n: number, spanX: number, spanY: number, seed: number): LabelBox[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => ({
    x: r() * spanX,
    y: r() * spanY,
    width: 30 + r() * 90,
    height: r() < 0.3 ? 18 : 15,
  }));
}

describe('layoutLabels on a spatial grid', () => {
  it('matches the linear scan for sparse, crowded and stacked scenes', () => {
    const scenes: LabelBox[][] = [
      scatter(60, 1200, 800, 1),
      scatter(150, 400, 300, 2), // crowded: many overlaps
      scatter(200, 60, 60, 3), // near-total pile-up
      Array.from({ length: 80 }, () => ({ x: 500, y: 300, width: 60, height: 15 })), // one column
      scatter(120, 1e6, 1e6, 4), // far-flung coordinates
    ];
    for (const boxes of scenes) expect(layoutLabels(boxes)).toEqual(layoutLabelsLinear(boxes));
  });

  it('keeps non-finite anchors on their preferred spot and out of the grid', () => {
    const boxes: LabelBox[] = [
      { x: NaN, y: 10, width: 40, height: 15 },
      { x: 100, y: 10, width: 40, height: 15 },
      { x: 100, y: Infinity, width: 40, height: 15 },
      { x: 100, y: 12, width: 40, height: 15 },
    ];
    expect(layoutLabels(boxes)).toEqual(layoutLabelsLinear(boxes));
  });

  it('lays out the label budget in bounded time even when every label is on one spot', () => {
    const boxes = Array.from({ length: MAX_DRAWN_LABELS }, () => ({ x: 300, y: 300, width: 60, height: 15 }));
    const t0 = performance.now();
    const out = layoutLabels(boxes);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(out).toHaveLength(MAX_DRAWN_LABELS);
  });

  it('lays out 20,000 scattered labels without the quadratic cost of the linear scan', () => {
    const boxes = scatter(20_000, 20_000, 20_000, 5);
    const t0 = performance.now();
    layoutLabels(boxes);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});

describe('selectLabelsToDraw', () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0, priority: false }));

  it('keeps every label at or under the cap, in order', () => {
    expect(selectLabelsToDraw(items(5), 5, 0, 0)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the labels nearest the screen centre past the cap', () => {
    expect(selectLabelsToDraw(items(10), 3, 9, 0)).toEqual([7, 8, 9]);
  });

  it('keeps priority labels first, wherever they are', () => {
    const list = items(10);
    list[0] = { x: 0, y: 0, priority: true };
    expect(selectLabelsToDraw(list, 3, 9, 0)).toEqual([0, 8, 9]);
  });

  it('treats a non-finite anchor as farthest', () => {
    const list = items(4);
    list[3] = { x: NaN, y: 0, priority: false };
    expect(selectLabelsToDraw(list, 3, 0, 0)).toEqual([0, 1, 2]);
  });
});

describe('MeasureOverlay label budget', () => {
  beforeAll(() => installFakeDom({ ns: true }));

  async function draw(n: number): Promise<{ texts: unknown[]; notes: { textContent: string }[] }> {
    const { MeasureOverlay } = await import('../src/render/measure/MeasureOverlay');
    const overlay = new MeasureOverlay();
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 10);
    camera.updateMatrixWorld(true);
    const r = rng(7);
    const labels = Array.from({ length: n }, (_, i) => ({
      anchor: [(r() - 0.5) * 8, (r() - 0.5) * 8, 0] as [number, number, number],
      text: `${i} m`,
      primary: i % 2 === 0,
    }));
    overlay.render(
      { polygons: [], edges: [], vertices: [], labels },
      camera,
      { clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement,
    );
    const kids = (overlay.element as unknown as { children: Array<{ tagName: string; getAttribute(n: string): string | null; textContent: string }> }).children;
    const texts = kids.filter((k) => k.tagName === 'text');
    return { texts, notes: texts.filter((k) => (k.getAttribute('class') ?? '').includes('olv-m-label-note')) };
  }

  it('draws every label and no note when the scene is within the budget', async () => {
    const { texts, notes } = await draw(50);
    expect(texts).toHaveLength(50);
    expect(notes).toHaveLength(0);
  });

  it('draws at most the budget and says how many were left out', async () => {
    const { texts, notes } = await draw(5_000);
    expect(texts).toHaveLength(MAX_DRAWN_LABELS + 1); // the labels plus the note
    expect(notes).toHaveLength(1);
    expect(notes[0].textContent).toContain(`${MAX_DRAWN_LABELS} of 5000`);
  });
});
