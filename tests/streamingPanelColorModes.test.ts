/**
 * streamingPanelColorModes.test.ts — the chip row across a republish.
 *
 * A 3D Tiles layer cannot state its channels at open: they are per tile, so the
 * row is published from the empty answer and republished once a tile has been
 * read. That republish carries the layer's DEFAULT mode, which would silently
 * throw away whatever the user had selected in between — a scan repainting
 * itself because a tile finished downloading.
 *
 * These cases pin the panel's side of it: what the row reports as active, what
 * survives a republish, and what happens when the user's mode is no longer on
 * offer. The DOM stub records listeners and dispatches clicks, so the selection
 * under test is the one a user makes rather than one the caller passes in.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { ColorMode } from '../src/render/colorModes';

class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  private readonly _listeners: (() => void)[] = [];
  readonly classList = {
    _set: new Set<string>(),
    add(c: string): void { this._set.add(c); },
    remove(c: string): void { this._set.delete(c); },
    toggle(c: string, on?: boolean): void {
      const want = on ?? !this._set.has(c);
      if (want) this._set.add(c); else this._set.delete(c);
    },
    contains(c: string): boolean { return this._set.has(c); },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  get ownText(): string { return this._text; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids.filter(Boolean));
  }
  addEventListener(_type: string, handler: () => void): void { this._listeners.push(handler); }
  blur(): void { /* no-op */ }
  click(): void { for (const h of this._listeners) h(); }
  /** Every descendant carrying the chip class, in row order. */
  chips(): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(' ').includes('olv-chip')) out.push(this);
    for (const c of this.children) out.push(...c.chips());
    return out;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement ??= class {};
  g.HTMLAnchorElement ??= class {};
});

function callbacks() {
  return {
    onColorMode: vi.fn(),
    onQuality: vi.fn(),
    onPauseToggle: vi.fn(),
    onClearCache: vi.fn(),
    onGradeFullCloud: vi.fn(),
    onCancelGrade: vi.fn(),
  };
}

async function panelWith(cb: ReturnType<typeof callbacks>) {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const panel = new StreamingPanel(cb);
  const root = panel.element as unknown as FakeEl;
  /** The colour chips only — the quality row's chips carry the same class. */
  const modeChip = (label: string): FakeEl => {
    const hit = root.chips().find((c) => c.ownText === label);
    if (!hit) throw new Error(`no chip labelled ${label}`);
    return hit;
  };
  const highlighted = (): string[] =>
    root.chips().filter((c) => c.classList.contains('olv-chip-active')).map((c) => c.ownText);
  return { panel, modeChip, highlighted };
}

const ELEVATION_ONLY: ColorMode[] = ['elevation'];
const WITH_NORMALS: ColorMode[] = ['elevation', 'normal'];
const WITH_COLOUR: ColorMode[] = ['rgb', 'elevation'];

describe('what the chip row reports as active', () => {
  it('names the mode the row opened on', async () => {
    const { panel } = await panelWith(callbacks());
    panel.setColorModes(WITH_COLOUR, 'rgb');
    expect(panel.activeColorMode()).toBe('rgb');
  });

  it('follows the user’s click', async () => {
    const cb = callbacks();
    const { panel, modeChip } = await panelWith(cb);
    panel.setColorModes(WITH_COLOUR, 'rgb');
    modeChip('Height').click();
    expect(panel.activeColorMode()).toBe('elevation');
    expect(cb.onColorMode).toHaveBeenCalledWith('elevation');
  });

  it('reports null when the selected mode is not one the row offers', async () => {
    const { panel } = await panelWith(callbacks());
    panel.setColorModes(ELEVATION_ONLY, 'normal');
    expect(
      panel.activeColorMode(),
      'no chip is highlighted, so naming one would claim a control the user cannot see',
    ).toBeNull();
  });
});

describe('a republish of the same scan’s row', () => {
  it('keeps the mode the user selected', async () => {
    const cb = callbacks();
    const { panel, modeChip, highlighted } = await panelWith(cb);
    panel.setColorModes(WITH_COLOUR, 'rgb');
    modeChip('Height').click();
    cb.onColorMode.mockClear();

    // The layer's answer moved: a tile stated normals. The row grows, and the
    // default it would open on is Color.
    panel.setColorModes(['rgb', 'elevation', 'normal'], 'rgb', true);

    expect(
      panel.activeColorMode(),
      'a tile finishing its download must not repaint the scan the user was reading',
    ).toBe('elevation');
    expect(highlighted()).toEqual(['Height']);
    expect(cb.onColorMode, 'nothing changed, so the renderer is not told to').not.toHaveBeenCalled();
  });

  it('adds the new chip without selecting it', async () => {
    const { panel, highlighted } = await panelWith(callbacks());
    panel.setColorModes(ELEVATION_ONLY, 'elevation');
    panel.setColorModes(WITH_NORMALS, 'elevation', true);
    expect(highlighted()).toEqual(['Height']);
    expect(panel.activeColorMode()).toBe('elevation');
  });

  it('falls back to the layer default, and moves the renderer, when the mode is withdrawn', async () => {
    const cb = callbacks();
    const { panel, modeChip } = await panelWith(cb);
    panel.setColorModes(['rgb', 'elevation', 'normal'], 'rgb');
    modeChip('Normal').click();
    cb.onColorMode.mockClear();

    panel.setColorModes(WITH_COLOUR, 'rgb', true);

    expect(
      panel.activeColorMode(),
      'a chip for a mode the layer cannot serve is the defect this row exists to prevent',
    ).toBe('rgb');
    expect(
      cb.onColorMode,
      'the row and the scene must not end up showing two different meanings',
    ).toHaveBeenCalledWith('rgb');
  });
});

describe('a fresh scan’s row', () => {
  it('opens on its own default rather than inheriting the previous scan’s mode', async () => {
    const { panel, modeChip } = await panelWith(callbacks());
    panel.setColorModes(WITH_COLOUR, 'rgb');
    modeChip('Height').click();

    // A second scan replaces the first. The panel is never hidden on a
    // streaming-to-streaming swap, so the previous selection is still here.
    panel.setColorModes(WITH_COLOUR, 'rgb');

    expect(panel.activeColorMode()).toBe('rgb');
  });
});
