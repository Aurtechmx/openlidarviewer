/**
 * The scrollbar gutter the rail handle has to account for.
 *
 * `.olv-ws-body` scrolls with `scrollbar-gutter: stable`, so the panel card is
 * laid out inside a content box that is narrower than the rail by the gutter.
 * The collapse handle is positioned against the rail's outer edge, so where a
 * gutter exists the handle detaches from the card and leaves a strip of scene
 * between a panel and its own control.
 *
 * The width is not a platform constant. This application sets it, through
 * `.olv-ws-body::-webkit-scrollbar`, which is why a machine with overlay
 * scrollbars still reserves it and why a probe without that class measures
 * zero. Measured in a real Chrome window: 9 px, and the handle moved from 8 px
 * clear of the card to 1 px overlapping it.
 *
 * Stubbed rather than run under jsdom, which is this repository's convention
 * for panel suites: the behaviour worth pinning is the arithmetic, the
 * property write and the probe cleanup, and none of them needs a layout engine
 * that would report zero for every box anyway.
 */
import { describe, it, expect } from 'vitest';
import {
  GUTTER_PROPERTY,
  measureGutterPx,
  publishGutterWidth,
} from '../src/ui/workspace/scrollbarGutter';

/** An element whose border and content boxes differ by a known amount. */
const scrollerWith = (gutter: number): HTMLElement =>
  ({ offsetWidth: 100 + gutter, clientWidth: 100 }) as unknown as HTMLElement;

interface FakeDoc {
  doc: Document;
  written: string[];
  created: { cls: string; removed: boolean }[];
  attached: number;
}

/** A document stub that records what the probe did to it. */
function fakeDocument(gutter: number, throwOnCreate = false): FakeDoc {
  const written: string[] = [];
  const created: { cls: string; removed: boolean }[] = [];
  let attached = 0;
  const doc = {
    createElement: () => {
      if (throwOnCreate) throw new Error('no DOM');
      const rec = { cls: '', removed: false };
      created.push(rec);
      const node = {
        style: { cssText: '' },
        appendChild: () => undefined,
        remove: () => { rec.removed = true; attached -= 1; },
        get className() { return rec.cls; },
        set className(v: string) { rec.cls = v; },
        offsetWidth: 120 + gutter,
        clientWidth: 120,
      };
      return node as unknown as HTMLElement;
    },
    body: { appendChild: () => { attached += 1; } },
    documentElement: { style: { setProperty: (_k: string, v: string) => { written.push(v); } } },
  } as unknown as Document;
  return { doc, written, created, get attached() { return attached; } } as FakeDoc;
}

describe('measuring a gutter', () => {
  it('reports the difference between the border and content boxes', () => {
    expect(measureGutterPx(scrollerWith(9))).toBe(9);
    expect(measureGutterPx(scrollerWith(15))).toBe(15);
  });

  it('reports none where the scrollbar overlays', () => {
    expect(measureGutterPx(scrollerWith(0))).toBe(0);
  });

  it('never reports a negative gutter, whatever the boxes say', () => {
    expect(measureGutterPx(scrollerWith(-4))).toBe(0);
  });
});

describe('publishing it', () => {
  it('publishes the measured width, so the handle can subtract it', () => {
    const f = fakeDocument(9);
    expect(publishGutterWidth(f.doc)).toBe(9);
    expect(f.written).toEqual(['9px']);
  });

  it('publishes zero where the scrollbar overlays', () => {
    const f = fakeDocument(0);
    expect(publishGutterWidth(f.doc)).toBe(0);
    expect(f.written).toEqual(['0px']);
  });

  it('probes with the real class, since the width comes from this app rather than the platform', () => {
    const f = fakeDocument(9);
    publishGutterWidth(f.doc);
    expect(f.created[0].cls).toBe('olv-ws-body');
  });

  it('leaves no probe behind', () => {
    const f = fakeDocument(9);
    publishGutterWidth(f.doc);
    // The probe is the element that carries the class and gets attached; the
    // filler inside it goes away with its parent.
    const probe = f.created.find((c) => c.cls === 'olv-ws-body');
    expect(probe?.removed).toBe(true);
  });

  it('publishes zero rather than nothing when it cannot measure at all', () => {
    const f = fakeDocument(9, true);
    expect(publishGutterWidth(f.doc)).toBe(0);
    expect(f.written).toEqual(['0px']);
  });

  it('cannot fail the workspace that calls it', () => {
    // Every workspace suite builds a document stub without a documentElement.
    // A cosmetic offset for a panel handle must not be able to take the rail
    // down with it, which it did until this was caught by those suites.
    const bare = { createElement: () => { throw new Error('x'); } } as unknown as Document;
    expect(() => publishGutterWidth(bare)).not.toThrow();
    expect(publishGutterWidth(bare)).toBe(0);
  });
});

describe('the stylesheet consumes it', () => {
  it('subtracts the gutter from the handle offset, with a zero fallback', async () => {
    const css = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/styles/72-panel-rails.css', import.meta.url), 'utf8'));
    // The fallback matters: a build where nothing published the property must
    // land on the geometry the rule had before this existed.
    // The property the module writes and the one the rule reads are the same
    // string, which nothing else checks and a rename would quietly break.
    expect(GUTTER_PROPERTY).toBe('--olv-ws-gutter');
    expect(css).toContain(`var(${GUTTER_PROPERTY}, 0px)`);
    expect(css).toMatch(/left:\s*calc\(14px \+ var\(--olv-rail-width\) - 1px - var\(--olv-ws-gutter, 0px\)\)/);
  });
});
