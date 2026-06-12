/**
 * scanTypeControl.test.ts
 *
 * The reusable "Treat scan as" control wired into both the Object/Space panel
 * and the terrain Analyse panel. It now renders a VISIBLE segmented selector —
 * Terrain · Object · Interior · Auto — highlights the active segment, surfaces a
 * subtle "(manual)" note when overridden, and fires a change callback on click.
 *
 * Runs in the node environment (no DOM), so it drives the builder through a
 * minimal recording DOM stub — the same stub-the-slice approach used in
 * tests/objectPanelSpace.test.ts, here covering buttons (dataset + click).
 */

import { describe, it, expect, beforeAll } from 'vitest';

type Handler = () => void;

/** A tiny fake element supporting only the surface the control touches. */
class FakeEl {
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly dataset: Record<string, string> = {};
  private readonly _attrs = new Map<string, string>();
  readonly children: FakeEl[] = [];
  private readonly _classes = new Set<string>();
  private readonly _handlers = new Map<string, Handler[]>();
  readonly tagName: string;
  readonly classList = {
    toggle: (cls: string, force?: boolean): void => {
      const on = force === undefined ? !this._classes.has(cls) : force;
      if (on) this._classes.add(cls); else this._classes.delete(cls);
    },
    contains: (cls: string): boolean => this._classes.has(cls),
  };
  constructor(tagName: string) { this.tagName = tagName; }
  set className(v: string) {
    this._classes.clear();
    for (const c of v.split(/\s+/).filter(Boolean)) this._classes.add(c);
  }
  get className(): string { return [...this._classes].join(' '); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  setAttribute(k: string, v: string): void { this._attrs.set(k, v); }
  getAttribute(k: string): string | null { return this._attrs.get(k) ?? null; }
  removeAttribute(k: string): void { this._attrs.delete(k); }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  addEventListener(type: string, fn: Handler): void {
    const list = this._handlers.get(type) ?? [];
    list.push(fn); this._handlers.set(type, list);
  }
  /** Test helper: simulate a click. */
  click(): void { for (const fn of this._handlers.get('click') ?? []) fn(); }
  /** Find the first descendant (or self) with the given class. */
  find(cls: string): FakeEl | null {
    if (this.classList.contains(cls)) return this;
    for (const c of this.children) { const hit = c.find(cls); if (hit) return hit; }
    return null;
  }
  /** All descendants (and self) with the given class. */
  findAll(cls: string, acc: FakeEl[] = []): FakeEl[] {
    if (this.classList.contains(cls)) acc.push(this);
    for (const c of this.children) c.findAll(cls, acc);
    return acc;
  }
}

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});

async function build(onChange: (o: string) => void = () => { /* noop */ }) {
  const { createScanTypeControl } = await import('../src/ui/scanTypeControl');
  const control = createScanTypeControl({ onChange: onChange as never });
  return { control, root: control.element as unknown as FakeEl };
}

describe('createScanTypeControl', () => {
  it('renders the four segments Terrain · Object · Interior · Auto', async () => {
    const { root } = await build();
    const opts = root.findAll('olv-scan-type-opt');
    expect(opts.map((o) => o.textContent)).toEqual(['Terrain', 'Object', 'Interior', 'Auto']);
    expect(opts.map((o) => o.dataset.value)).toEqual(['terrain', 'object', 'interior', 'auto']);
    expect(root.textContent).toContain('Treat scan as');
    // All are real buttons.
    expect(opts.every((o) => o.type === 'button')).toBe(true);
  });

  it('highlights the active segment and shows "(manual)" only when overridden', async () => {
    const { control, root } = await build();
    const note = root.find('olv-scan-type-note')!;
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;

    control.set('auto', 'object');
    expect(byVal('auto').classList.contains('is-active')).toBe(true);
    expect(byVal('interior').classList.contains('is-active')).toBe(false);
    expect(note.classList.contains('olv-hidden')).toBe(true);

    control.set('interior', 'interior');
    expect(byVal('interior').classList.contains('is-active')).toBe(true);
    expect(byVal('interior').getAttribute('aria-pressed')).toBe('true');
    expect(byVal('auto').classList.contains('is-active')).toBe(false);
    expect(note.classList.contains('olv-hidden')).toBe(false);
    expect(note.textContent).toContain('manual');
  });

  it('fires the change callback with the clicked segment value', async () => {
    const seen: string[] = [];
    const { root } = await build((o) => seen.push(o));
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    byVal('interior').click();
    byVal('terrain').click();
    byVal('auto').click();
    expect(seen).toEqual(['interior', 'terrain', 'auto']);
  });
});

// The product decision for the dead-panel bug: when detection reads the scan
// as an interior / compact object, the Terrain segment is DISABLED with the
// reason — disabled + title/aria-disabled + a visible reason line — so one
// click can no longer tear down the Space/Object panel. The explicit
// "Run terrain contours anyway" hatch (host-side) is the deliberate override.
describe('createScanTypeControl — disabled-with-reason', () => {
  const REASON =
    "This scan reads as an interior — terrain analysis would be misleading. " +
    "Use 'Run terrain contours anyway' to override.";

  it('disables the listed segment with title, aria-disabled and the reason line', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;

    control.set('auto', 'interior', { terrain: REASON });
    const terrain = byVal('terrain');
    expect(terrain.disabled).toBe(true);
    expect(terrain.classList.contains('is-disabled')).toBe(true);
    expect(terrain.getAttribute('aria-disabled')).toBe('true');
    expect(terrain.title).toBe(REASON);
    // The visible reason line carries the same text and is no longer hidden.
    const reason = root.find('olv-scan-type-reason')!;
    expect(reason.textContent).toBe(REASON);
    expect(reason.classList.contains('olv-hidden')).toBe(false);
    // The other three pills stay fully clickable.
    for (const v of ['object', 'interior', 'auto']) {
      expect(byVal(v).disabled).toBe(false);
      expect(byVal(v).getAttribute('aria-disabled')).toBe('false');
      expect(byVal(v).classList.contains('is-disabled')).toBe(false);
    }
  });

  it('a click on the disabled segment is a guarded no-op', async () => {
    const seen: string[] = [];
    const { control, root } = await build((o) => seen.push(o));
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', { terrain: REASON });
    byVal('terrain').click();   // disabled — must not fire
    byVal('interior').click();  // enabled — must fire
    expect(seen).toEqual(['interior']);
  });

  it('never locks out the CURRENT override — a forced choice stays escapable', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    // The user already forced terrain (e.g. via the escape hatch / earlier
    // state): the Terrain segment must show as ACTIVE, not disabled, and the
    // way back (Auto / Object / Interior) stays enabled.
    control.set('terrain', 'terrain', { terrain: REASON });
    const terrain = byVal('terrain');
    expect(terrain.classList.contains('is-active')).toBe(true);
    expect(terrain.disabled).toBe(false);
    expect(terrain.getAttribute('aria-disabled')).toBe('false');
    for (const v of ['object', 'interior', 'auto']) {
      expect(byVal(v).disabled).toBe(false);
    }
    // No segment is disabled, so the reason line hides.
    const reason = root.find('olv-scan-type-reason')!;
    expect(reason.classList.contains('olv-hidden')).toBe(true);
  });

  it('re-enables cleanly when the disabled map is dropped', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', { terrain: REASON });
    expect(byVal('terrain').disabled).toBe(true);

    control.set('auto', 'terrain'); // detection now says terrain — no map
    const terrain = byVal('terrain');
    expect(terrain.disabled).toBe(false);
    expect(terrain.classList.contains('is-disabled')).toBe(false);
    expect(terrain.getAttribute('aria-disabled')).toBe('false');
    expect(terrain.title).toBe('');
    const reason = root.find('olv-scan-type-reason')!;
    expect(reason.classList.contains('olv-hidden')).toBe(true);
    expect(reason.textContent).toBe('');
  });
});

// v0.4.5: while detection is UNSETTLED under Auto, the RESOLVED verdict is
// shown without being adopted — the detected pill gets an `is-detected` mark +
// aria-description and the Auto label reads "Auto (Interior)". Auto stays the
// active (aria-pressed) segment until the host reports the verdict as settled
// (see the soft-commit describe below).
describe('createScanTypeControl — detected-type display under Auto (unsettled)', () => {
  it('marks the detected pill and relabels Auto when detection resolves interior', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;

    control.set('auto', 'interior', { terrain: 'reads as interior' });
    const interior = byVal('interior');
    const auto = byVal('auto');
    // Auto remains the SELECTED mode…
    expect(auto.classList.contains('is-active')).toBe(true);
    expect(auto.getAttribute('aria-pressed')).toBe('true');
    expect(interior.classList.contains('is-active')).toBe(false);
    // …while the Interior pill is visibly marked as the detected type…
    expect(interior.classList.contains('is-detected')).toBe(true);
    expect(interior.getAttribute('aria-description')).toContain('Detected automatically');
    expect(interior.getAttribute('aria-description')).toContain('interior');
    // …and the Auto label carries the resolved verdict.
    expect(auto.textContent).toBe('Auto (Interior)');
    // The detected pill stays clickable (only Terrain is ruled out here).
    expect(interior.disabled).toBe(false);
  });

  it('marks the terrain pill when detection resolves terrain', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'terrain');
    expect(byVal('terrain').classList.contains('is-detected')).toBe(true);
    expect(byVal('auto').textContent).toBe('Auto (Terrain)');
    expect(byVal('interior').classList.contains('is-detected')).toBe(false);
  });

  it('clears the detected mark + label under a manual override and on re-detection', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;

    control.set('auto', 'interior');
    expect(byVal('interior').classList.contains('is-detected')).toBe(true);

    // Manual override: the override pill is active; no pill claims "detected"
    // (the effective route is the user's choice, not a detection) and the Auto
    // label reverts to plain "Auto".
    control.set('object', 'object');
    for (const v of ['terrain', 'object', 'interior', 'auto']) {
      expect(byVal(v).classList.contains('is-detected')).toBe(false);
      expect(byVal(v).getAttribute('aria-description')).toBe(null);
    }
    expect(byVal('auto').textContent).toBe('Auto');

    // Back to Auto with a NEW verdict: the mark moves, never accumulates.
    control.set('auto', 'object');
    expect(byVal('object').classList.contains('is-detected')).toBe(true);
    expect(byVal('interior').classList.contains('is-detected')).toBe(false);
    expect(byVal('auto').textContent).toBe('Auto (Object)');
  });

  it('shows plain "Auto" while detection has not resolved yet', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', null);
    expect(byVal('auto').textContent).toBe('Auto');
    for (const v of ['terrain', 'object', 'interior']) {
      expect(byVal(v).classList.contains('is-detected')).toBe(false);
    }
  });
});

// The settled soft-commit: once the host reports the auto verdict as SETTLED
// (static-load detection or the streaming settle one-shot), the control
// COMMITS to the detected type — the detected pill becomes the selected
// segment (aria-pressed), still wearing its "detected" accent dot so the
// auto-detected origin stays visible. NOT a manual override: no "(manual)"
// note, every pill (including Auto, the way back to re-detection) stays
// clickable, and the host resets the flag on a new scan.
describe('createScanTypeControl — settled soft-commit', () => {
  const REASON =
    "This scan reads as an interior — terrain analysis would be misleading. " +
    "Use 'Run terrain contours anyway' to override.";

  it('commits the selection to the detected pill (aria-pressed moves off Auto)', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', { terrain: REASON }, true);
    const interior = byVal('interior');
    const auto = byVal('auto');
    expect(interior.classList.contains('is-active')).toBe(true);
    expect(interior.getAttribute('aria-pressed')).toBe('true');
    expect(auto.classList.contains('is-active')).toBe(false);
    expect(auto.getAttribute('aria-pressed')).toBe('false');
    // The accent dot still says "this was auto-detected".
    expect(interior.classList.contains('is-detected')).toBe(true);
    expect(interior.getAttribute('aria-description')).toContain('Detected automatically');
  });

  it('a commit is NOT a manual override: no "(manual)" note, plain Auto pill', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', undefined, true);
    expect(root.find('olv-scan-type-note')!.classList.contains('olv-hidden')).toBe(true);
    // Auto reverts to a plain pill — its job is now "re-run detection".
    expect(byVal('auto').textContent).toBe('Auto');
    expect(byVal('auto').title).toContain('re-run auto-detection');
  });

  it('every pill stays clickable after the commit — including Auto (re-detect)', async () => {
    const seen: string[] = [];
    const { control, root } = await build((o) => seen.push(o));
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', { terrain: REASON }, true);
    byVal('auto').click();     // back to re-detection
    byVal('object').click();   // any manual pick
    byVal('interior').click(); // re-clicking the committed pill is harmless
    expect(seen).toEqual(['auto', 'object', 'interior']);
  });

  it('keeps the disabled-Terrain reason exactly as in the uncommitted state', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', { terrain: REASON }, true);
    const terrain = byVal('terrain');
    expect(terrain.disabled).toBe(true);
    expect(terrain.getAttribute('aria-disabled')).toBe('true');
    expect(terrain.title).toBe(REASON);
    const reason = root.find('olv-scan-type-reason')!;
    expect(reason.textContent).toBe(REASON);
    expect(reason.classList.contains('olv-hidden')).toBe(false);
  });

  it('commits the Terrain pill when the settled verdict is terrain', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'terrain', undefined, true);
    expect(byVal('terrain').classList.contains('is-active')).toBe(true);
    expect(byVal('terrain').classList.contains('is-detected')).toBe(true);
    expect(byVal('auto').classList.contains('is-active')).toBe(false);
  });

  it('a new scan returns the selection to Auto (host passes committed=false)', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    control.set('auto', 'interior', undefined, true);
    expect(byVal('interior').classList.contains('is-active')).toBe(true);
    // New scan: detection unresolved again, no commit.
    control.set('auto', null);
    expect(byVal('auto').classList.contains('is-active')).toBe(true);
    expect(byVal('auto').getAttribute('aria-pressed')).toBe('true');
    expect(byVal('interior').classList.contains('is-active')).toBe(false);
    expect(byVal('interior').classList.contains('is-detected')).toBe(false);
  });

  it('a manual override beats the committed flag; unresolved detection ignores it', async () => {
    const { control, root } = await build();
    const byVal = (v: string) => root.findAll('olv-scan-type-opt').find((o) => o.dataset.value === v)!;
    // Manual override + committed=true (host race): the override pill wins.
    control.set('object', 'object', undefined, true);
    expect(byVal('object').classList.contains('is-active')).toBe(true);
    expect(root.find('olv-scan-type-note')!.classList.contains('olv-hidden')).toBe(false);
    // committed with NO resolved verdict: stays on Auto (nothing to commit to).
    control.set('auto', null, undefined, true);
    expect(byVal('auto').classList.contains('is-active')).toBe(true);
  });
});
