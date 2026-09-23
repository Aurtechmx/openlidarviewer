/**
 * rangeWorkbenchKeyboard.test.ts — the acquisition-grid canvas answers the
 * keyboard, not only the mouse.
 *
 * ANALYSIS-F1: the workbench's cell-inspection canvas (`RangeWorkbench.ts`)
 * had no `tabIndex`, no `role` and no `keydown` listener, so the hover and
 * click-to-resolve interaction that is the file's own "THE SPLIT THAT
 * MATTERS" comment was entirely unreachable without a pointer. This pins:
 *   - the canvas is a focusable, labelled widget;
 *   - arrow keys move a cursor cell and reveal the marker, clamped to the
 *     grid, mirroring the mouse-hover readout;
 *   - Enter/Space samples the cursor cell through the SAME `resolveCellLink`
 *     path a click uses — both the linked and the refused outcome;
 *   - mouse hover/click still work unmodified (no regression).
 *
 * Runs in the node environment via a small recording DOM stub (the canvas 2D
 * context is unavailable in the stub — RangeWorkbench's paint path is
 * null-safe, same convention as tests/analysePanelCoverageTile.test.ts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  CellState,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
  cellIndexOf,
  tallyCellStates,
} from '../src/model/OrganizedRange';

type Handler = (e: unknown) => void;

class FakeEl {
  tagName: string;
  className = '';
  title = '';
  tabIndex = -1;
  width = 0;
  height = 0;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  private readonly handlers = new Map<string, Handler[]>();
  private _classes = new Set<string>();

  constructor(tag: string) {
    this.tagName = tag;
  }
  get classList() {
    const classes = this._classes;
    return {
      add: (c: string): void => void classes.add(c),
      remove: (c: string): void => void classes.delete(c),
      contains: (c: string): boolean => classes.has(c),
      toggle: (c: string, force?: boolean): boolean => {
        const want = force === undefined ? !classes.has(c) : force;
        if (want) classes.add(c);
        else classes.delete(c);
        return want;
      },
    };
  }
  set textContent(v: string) {
    this._text = v;
  }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  removeAttribute(n: string): void {
    this.attrs.delete(n);
  }
  addEventListener(type: string, fn: Handler): void {
    const a = this.handlers.get(type) ?? [];
    a.push(fn);
    this.handlers.set(type, a);
  }
  dispatchEvent(evt: { type: string }): boolean {
    for (const fn of this.handlers.get(evt.type) ?? []) fn(evt);
    return true;
  }
  /** Canvas 2D context is unavailable in the stub; RangeWorkbench guards every use. */
  getContext(): null {
    return null;
  }
  getBoundingClientRect(): { width: number; height: number; left: number; top: number } {
    return { width: 4, height: 2, left: 0, top: 0 };
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

/**
 * 4 columns by 2 rows, EXACT linkage. Row 1 column 0 is NO_RETURN (a
 * refusal case); every other cell is a VALID_RETURN whose record is its
 * cell index + 50 — the same fixed construction organizedRangeCellLink.test.ts
 * pins, so "row 1, column 3 resolves to record 57" is a known, tested fact
 * rather than something this file has to re-derive.
 */
function makeSet(): OrganizedRangeSet {
  const width = 4;
  const height = 2;
  const cellState = new Uint8Array(width * height).fill(CellState.VALID_RETURN);
  const cellToRecord = new Int32Array(width * height);
  for (let i = 0; i < cellToRecord.length; i++) cellToRecord[i] = i + 50;
  cellState[cellIndexOf(1, 0, width)] = CellState.NO_RETURN;
  cellToRecord[cellIndexOf(1, 0, width)] = -1;
  const frame: OrganizedRangeFrame = {
    id: 'setup-1',
    sourceKind: 'ptx-grid',
    width,
    height,
    cellState,
    cellToRecord,
    linkage: { kind: 'exact' },
    diagnostics: tallyCellStates(cellState),
  };
  return { kind: 'organized-range', frames: [frame], organization: 'organized-grid' };
}

describe('RangeWorkbench keyboard cell inspection', () => {
  it('makes the canvas a focusable, labelled widget', async () => {
    const { RangeWorkbench } = await import('../src/ui/RangeWorkbench');
    const wb = new RangeWorkbench({ set: makeSet(), layerId: 'L1' });
    const canvas = (wb as unknown as { _canvas: FakeEl })._canvas;
    expect(canvas.tabIndex).toBe(0);
    expect(canvas.getAttribute('role')).toBeTruthy();
    expect(canvas.getAttribute('aria-label')).toBeTruthy();
  });

  it('moves a visible cursor cell with the arrow keys, clamped to the grid', async () => {
    const { RangeWorkbench } = await import('../src/ui/RangeWorkbench');
    const wb = new RangeWorkbench({ set: makeSet(), layerId: 'L1' });
    const canvas = (wb as unknown as { _canvas: FakeEl })._canvas;
    const marker = (wb as unknown as { _marker: FakeEl })._marker;
    const hover = (wb as unknown as { _hover: FakeEl })._hover;

    expect(marker.classList.contains('olv-hidden')).toBe(true);

    // Four ArrowRight from the implicit (0,0) origin land on column 3 and clamp
    // there (width is 4), so the fourth press proves the clamp, not just the count.
    for (let i = 0; i < 4; i++) {
      canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    }
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} } as never);

    expect((wb as unknown as { _cursor: { row: number; column: number } })._cursor).toEqual({
      row: 1,
      column: 3,
    });
    // Moving alone reveals the cursor and describes the cell, same as a mouse hover.
    expect(marker.classList.contains('olv-hidden')).toBe(false);
    expect(hover.textContent).toContain('Row 1, column 3');
    expect(hover.textContent).toContain('Valid return');
  });

  it('Enter samples the cursor cell through the same resolveCellLink a click uses', async () => {
    const { RangeWorkbench } = await import('../src/ui/RangeWorkbench');
    const highlighted: (number | null)[] = [];
    const wb = new RangeWorkbench({
      set: makeSet(),
      layerId: 'L1',
      onHighlightRecord: (r) => highlighted.push(r),
    });
    const canvas = (wb as unknown as { _canvas: FakeEl })._canvas;
    const readout = (wb as unknown as { _readout: FakeEl })._readout;

    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} } as never);

    expect(readout.textContent).toContain('Row 1, column 3');
    expect(highlighted).toEqual([57]);
  });

  it('Enter on a NO_RETURN cell refuses, same as a click, and clears the highlight', async () => {
    const { RangeWorkbench } = await import('../src/ui/RangeWorkbench');
    const highlighted: (number | null)[] = [];
    const wb = new RangeWorkbench({
      set: makeSet(),
      layerId: 'L1',
      onHighlightRecord: (r) => highlighted.push(r),
    });
    const canvas = (wb as unknown as { _canvas: FakeEl })._canvas;
    const readout = (wb as unknown as { _readout: FakeEl })._readout;

    // Row 1, column 0 — reachable with a single ArrowDown from the origin.
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} } as never);
    canvas.dispatchEvent({ type: 'keydown', key: ' ', preventDefault() {} } as never);

    expect(readout.textContent).toContain('No return');
    expect(highlighted).toEqual([null]);
  });

  it('a mode/frame refresh drops a stale cursor rather than clamping it into the wrong cell', async () => {
    const { RangeWorkbench } = await import('../src/ui/RangeWorkbench');
    const wb = new RangeWorkbench({ set: makeSet(), layerId: 'L1' });
    const canvas = (wb as unknown as { _canvas: FakeEl })._canvas;
    canvas.dispatchEvent({ type: 'keydown', key: 'ArrowRight', preventDefault() {} } as never);
    expect((wb as unknown as { _cursor: unknown })._cursor).not.toBeNull();
    (wb as unknown as { refresh: () => void }).refresh();
    expect((wb as unknown as { _cursor: unknown })._cursor).toBeNull();
  });

  it('leaves mouse hover and click behaviour unchanged', async () => {
    const { RangeWorkbench } = await import('../src/ui/RangeWorkbench');
    const highlighted: (number | null)[] = [];
    const wb = new RangeWorkbench({
      set: makeSet(),
      layerId: 'L1',
      onHighlightRecord: (r) => highlighted.push(r),
    });
    const canvas = (wb as unknown as { _canvas: FakeEl })._canvas;
    const hover = (wb as unknown as { _hover: FakeEl })._hover;
    const readout = (wb as unknown as { _readout: FakeEl })._readout;

    // The stub's getBoundingClientRect is 4x2 — the display raster's own
    // size for this small grid — so a client point maps 1:1 onto a cell.
    canvas.dispatchEvent({ type: 'mousemove', clientX: 3.5, clientY: 0.5 } as never);
    expect(hover.textContent).toContain('Row 0, column 3');

    canvas.dispatchEvent({ type: 'click', clientX: 3.5, clientY: 1.5 } as never);
    expect(readout.textContent).toContain('Row 1, column 3');
    expect(highlighted).toEqual([57]);
  });
});
