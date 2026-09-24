/**
 * analyseSurfaceTilesKeyboard.test.ts
 *
 * ANALYSIS-F2: the Analyse panel's sampled raster tiles (canopy height,
 * coverage/trust, relief) were click-to-sample only — `_attachCoverageSampler`
 * and `_attachSampler` in `analyseSurfaceTiles.ts` wired a bare `click`
 * listener onto an unfocusable canvas, with no keyboard equivalent to the
 * per-cell confidence/elevation readout. This pins:
 *   - each sampled canvas is a focusable, labelled widget;
 *   - arrow keys move a visible cursor (the same crosshair a click drops)
 *     without sampling;
 *   - Enter/Space samples the cursor cell through the SAME per-cell read a
 *     click produces;
 *   - mouse click-to-sample still works unmodified (no regression).
 *
 * Runs in the node environment via a recording DOM stub, driven with a REAL
 * `analyseContours()` result (same fixture as tests/analysePanelCoverageTile.test.ts)
 * so the tiles actually render.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { FakeEl } from './helpers/canvasKeyboardDomFake';
import { hillScene } from './helpers/hillSceneFixture';

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
  };
  // Forces the relief tile's repaint-coalescing onto its synchronous fallback
  // path, same as tests/analysePanelCoverageTile.test.ts.
  (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame = undefined;
});

/** First canvas in a subtree, depth-first. */
function firstCanvas(root: FakeEl): FakeEl | null {
  if (root.tagName === 'canvas') return root;
  for (const c of root.children) {
    const hit = firstCanvas(c);
    if (hit) return hit;
  }
  return null;
}
/** First descendant whose own text equals `label`, else undefined. */
function findByText(root: FakeEl, label: string): FakeEl | undefined {
  for (const c of root.children) {
    if ((c as unknown as { _text?: string })._text === label) return c;
    const hit = findByText(c, label);
    if (hit) return hit;
  }
  return undefined;
}
/** The `.olv-analyse-sample` readout inside a tile. */
function findReadout(root: FakeEl): FakeEl | undefined {
  if (root.className === 'olv-analyse-sample') return root;
  for (const c of root.children) {
    const hit = findReadout(c);
    if (hit) return hit;
  }
  return undefined;
}
/** The tile div whose own subtree contains `sublabel`'s text node. */
function findTile(elements: readonly FakeEl[], sublabel: string): FakeEl {
  for (const el of elements) {
    if (findByText(el, sublabel)) return el;
  }
  throw new Error(`tile "${sublabel}" not found`);
}

describe('Analyse surface tiles — keyboard cell sampling', () => {
  async function render(): Promise<readonly FakeEl[]> {
    const { SurfaceTiles } = await import('../src/ui/analyseSurfaceTiles');
    const result = analyseContours(hillScene(), {
      cellSizeM: 2,
      crs: 'EPSG:32610',
      verticalDatum: 'EPSG:5703',
    });
    const tiles = new SurfaceTiles({
      cb: {},
      getResult: () => result,
      setConfidenceColorButton: () => {},
    });
    return tiles.render(result).elements as unknown as readonly FakeEl[];
  }

  it('makes the canopy-height and coverage canvases focusable, labelled widgets', async () => {
    const elements = await render();
    for (const label of ['Canopy height (CHM)', 'Coverage (trust)']) {
      const canvas = firstCanvas(findTile(elements, label));
      expect(canvas, `${label} canvas`).not.toBeNull();
      expect(canvas!.tabIndex).toBe(0);
      expect(canvas!.getAttribute('role')).toBeTruthy();
      expect(canvas!.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('arrow keys move a visible cursor without sampling', async () => {
    const elements = await render();
    const tile = findTile(elements, 'Coverage (trust)');
    const canvas = firstCanvas(tile)!;
    const readout = findReadout(tile)!;
    const before = readout.textContent;

    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} } as never);

    // The readout (a live region) does not change on movement alone — matches
    // the mouse, which never samples on hover either, only on click.
    expect(readout.textContent).toBe(before);
  });

  it('Enter samples the coverage cursor cell through the same per-cell read a click produces', async () => {
    const elements = await render();
    const tile = findTile(elements, 'Coverage (trust)');
    const canvas = firstCanvas(tile)!;
    const readout = findReadout(tile)!;

    expect(readout.textContent).toMatch(/Click the map/);
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} } as never);

    expect(readout.textContent).toMatch(/^Sample · /);
    expect(readout.textContent).not.toMatch(/Click the map/);
  });

  it('Enter samples the canopy-height cursor cell (the sampleTerrain path)', async () => {
    const elements = await render();
    const tile = findTile(elements, 'Canopy height (CHM)');
    const canvas = firstCanvas(tile)!;
    const readout = findReadout(tile)!;

    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: ' ', preventDefault() {} } as never);

    expect(readout.textContent).toMatch(/^Sample · /);
  });

  it('leaves mouse click-to-sample unchanged', async () => {
    const elements = await render();
    const tile = findTile(elements, 'Coverage (trust)');
    const canvas = firstCanvas(tile)!;
    const readout = findReadout(tile)!;

    canvas.dispatchEvent({
      type: 'click',
      clientX: Math.floor(canvas.width / 2),
      clientY: Math.floor(canvas.height / 2),
    } as never);

    expect(readout.textContent).toMatch(/^Sample · /);
  });
});
