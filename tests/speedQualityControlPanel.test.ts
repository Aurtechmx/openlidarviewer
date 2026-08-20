/**
 * speedQualityControlPanel.test.ts
 *
 * The Speed ↔ Quality header control's DOM behaviour, in the node environment
 * through the same recording stub the other panel suites use (no jsdom).
 *
 * What matters here is not that the markup exists but that the control keeps
 * four promises:
 *
 *   - the popover markup stays out of the startup shell until the first click,
 *     while the stored position is applied during construction;
 *   - the initial apply is marked NOT user-initiated, because the shell's
 *     preference file is read back after the control mounts and persisting
 *     boot defaults there would overwrite a saved choice;
 *   - moving the slider leaves Auto and applies the new position;
 *   - Advanced still exposes every knob the slider drives, individually, and
 *     pinning one leaves the others where they were.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  QUALITY_MAX,
  QUALITY_MIN,
  midQualityPosition,
  type QualityDevice,
  type QualityPreference,
  type QualitySettings,
} from '../src/render/quality/qualityPolicy';
import { DEFAULT_QUALITY_PREFERENCE } from '../src/ui/qualityPreferenceStore';

class FakeEl {
  readonly tagName: string;
  className = '';
  title = '';
  type = '';
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  value = '';
  min = '';
  max = '';
  step = '';
  focused = 0;
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  private _text = '';
  private _html = '';
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  readonly classList = {
    add: (c: string): void => {
      if (!this.classList.contains(c)) this.className = `${this.className} ${c}`.trim();
    },
    remove: (c: string): void => {
      this.className = this.className.split(/\s+/).filter((x) => x !== c).join(' ');
    },
    toggle: (c: string, force?: boolean): void => {
      const want = force ?? !this.classList.contains(c);
      if (want) this.classList.add(c);
      else this.classList.remove(c);
    },
    contains: (c: string): boolean => this.className.split(/\s+/).includes(c),
  };

  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  /** This node's own text, ignoring descendants — for exact label assertions. */
  get ownText(): string { return this._text; }
  set innerHTML(v: string) { this._html = v; }
  get innerHTML(): string { return this._html; }

  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  append(...kids: Array<FakeEl | string>): void {
    for (const k of kids) if (k instanceof FakeEl) this.children.push(k);
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string): void { for (const fn of this.listeners.get(type) ?? []) fn(); }
  click(): void { this.fire('click'); }
  focus(): void { this.focused += 1; }
  contains(node: FakeEl): boolean {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  /** Every descendant (incl. self) carrying `cls`. */
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
  /** The single descendant with `cls`; throws when the assumption is wrong. */
  one(cls: string): FakeEl {
    const found = this.findByClass(cls);
    if (found.length !== 1) throw new Error(`expected exactly one .${cls}, found ${found.length}`);
    return found[0];
  }
  /** Every descendant of a given tag. */
  byTag(tag: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.tagName === tag.toUpperCase()) out.push(this);
    for (const c of this.children) out.push(...c.byTag(tag));
    return out;
  }
}

const documentListeners = new Map<string, Array<(event: unknown) => void>>();

beforeAll(() => {
  const g = globalThis as unknown as {
    document: unknown;
    Node: unknown;
    HTMLInputElement: unknown;
    HTMLAnchorElement: unknown;
  };
  // `el()` narrows with `instanceof` before assigning `type` / `href`, and the
  // dismissal handler tests its event target with `instanceof Node`. Point all
  // three at the stub so those guards behave as they do in a browser.
  g.Node = FakeEl;
  g.HTMLInputElement = FakeEl;
  g.HTMLAnchorElement = FakeEl;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    addEventListener: (type: string, fn: (event: unknown) => void): void => {
      const list = documentListeners.get(type) ?? [];
      list.push(fn);
      documentListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void): void => {
      documentListeners.set(type, (documentListeners.get(type) ?? []).filter((f) => f !== fn));
    },
  };
});

beforeEach(() => documentListeners.clear());

const DESKTOP: QualityDevice = { tier: 'high', isMobile: false, backend: 'webgpu' };

interface Applied {
  readonly settings: QualitySettings;
  readonly userInitiated: boolean;
}

async function makeControl(
  preference: QualityPreference = DEFAULT_QUALITY_PREFERENCE,
  liveStreamingQuality?: () => 'low' | 'balanced' | 'high',
) {
  const { QualityControl } = await import('../src/ui/qualityControl');
  const applied: Applied[] = [];
  const persisted: QualityPreference[] = [];
  const control = new QualityControl({
    device: DESKTOP,
    preference,
    onApply: (settings, userInitiated) => { applied.push({ settings, userInitiated }); },
    onPersist: (p) => { persisted.push(p); },
    ...(liveStreamingQuality ? { liveStreamingQuality } : {}),
  });
  const root = control.element as unknown as FakeEl;
  return { control, root, applied, persisted };
}

/** Open the panel and hand back its root. */
async function openPanel(
  preference?: QualityPreference,
  liveStreamingQuality?: () => 'low' | 'balanced' | 'high',
) {
  const made = await makeControl(preference, liveStreamingQuality);
  await made.control.open();
  return { ...made, panel: made.root.one('olv-quality-pop') };
}

describe('Speed ↔ Quality control — mounting', () => {
  it('applies once at construction, marked as not user-initiated', async () => {
    const { applied, persisted } = await makeControl();
    expect(applied).toHaveLength(1);
    expect(applied[0].userInitiated).toBe(false);
    // Nothing is persisted before the user has chosen anything.
    expect(persisted).toHaveLength(0);
  });

  it('mounts a button and no panel markup until the first open', async () => {
    const { root, control } = await makeControl();
    expect(root.findByClass('olv-quality-button')).toHaveLength(1);
    expect(root.findByClass('olv-quality-pop')).toHaveLength(0);
    await control.open();
    expect(root.findByClass('olv-quality-pop')).toHaveLength(1);
  });

  it('opens and closes from the header button, and reports it to assistive tech', async () => {
    const { root, control, panel } = await openPanel();
    const button = root.one('olv-quality-button');
    expect(panel.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    control.close();
    expect(panel.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(control.isOpen).toBe(false);
  });

  it('loads the panel chunk once across repeated opens', async () => {
    const { root, control } = await makeControl();
    await control.open();
    control.close();
    await control.open();
    expect(root.findByClass('olv-quality-pop')).toHaveLength(1);
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { root, panel } = await openPanel();
    for (const fn of documentListeners.get('keydown') ?? []) fn({ key: 'Escape' });
    expect(panel.hidden).toBe(true);
    expect(root.one('olv-quality-button').focused).toBe(1);
  });

  it('removes its document listeners on dispose', async () => {
    const { control } = await makeControl();
    expect((documentListeners.get('keydown') ?? []).length).toBe(1);
    control.dispose();
    expect((documentListeners.get('keydown') ?? []).length).toBe(0);
    expect((documentListeners.get('pointerdown') ?? []).length).toBe(0);
  });
});

describe('Speed ↔ Quality control — the slider', () => {
  it('spans the policy range and starts on the automatic position', async () => {
    const { panel, applied } = await openPanel();
    const slider = panel.one('olv-slider');
    expect(slider.min).toBe(String(QUALITY_MIN));
    expect(slider.max).toBe(String(QUALITY_MAX));
    expect(slider.value).toBe(String(applied[0].settings.position));
    // Auto owns the position, so the slider is not draggable until Auto is off.
    expect(slider.disabled).toBe(true);
  });

  it('leaves Auto, applies, and persists when moved', async () => {
    const { panel, applied, persisted } = await openPanel();
    const auto = panel.one('olv-quality-auto').byTag('input')[0];
    auto.checked = false;
    auto.fire('change');

    const slider = panel.one('olv-slider');
    expect(slider.disabled).toBe(false);
    slider.value = String(QUALITY_MAX);
    slider.fire('input');

    const last = applied[applied.length - 1];
    expect(last.userInitiated).toBe(true);
    expect(last.settings.position).toBe(QUALITY_MAX);
    expect(last.settings.streamingQuality).toBe('high');
    expect(persisted[persisted.length - 1]).toEqual({
      auto: false,
      position: QUALITY_MAX,
      overrides: {},
    });
  });

  it('reads Speed at one end and Quality at the other', async () => {
    const { panel } = await openPanel({ auto: false, position: QUALITY_MIN, overrides: {} });
    const label = panel.one('olv-quality-position');
    expect(label.ownText).toBe('Speed');
    const slider = panel.one('olv-slider');
    slider.value = String(QUALITY_MAX);
    slider.fire('input');
    expect(label.ownText).toBe('Quality');
  });

  it('sits on Balanced at the midpoint', async () => {
    const { panel } = await openPanel({ auto: false, position: midQualityPosition(), overrides: {} });
    expect(panel.one('olv-quality-position').ownText).toBe('Balanced');
  });
});

describe('Speed ↔ Quality control — Advanced', () => {
  it('exposes every knob the slider drives, individually', async () => {
    const { panel } = await openPanel();
    const advanced = panel.one('olv-quality-advanced');
    // Streaming preset chips + pixel-ratio chips.
    const chipRows = advanced.findByClass('olv-quality-chips');
    expect(chipRows).toHaveLength(2);
    expect(chipRows[0].children.map((c) => c.ownText)).toEqual(['Low', 'Balanced', 'High']);
    expect(chipRows[1].children.map((c) => c.ownText)).toEqual(['1×', '1.25×', '1.5×', '2×']);
    // Eye Dome Lighting + antialiasing checkboxes.
    expect(advanced.findByClass('olv-quality-check')).toHaveLength(2);
  });

  it('pins a knob without moving the rest, and says the position was adjusted', async () => {
    const { panel, applied } = await openPanel({ auto: false, position: QUALITY_MIN, overrides: {} });
    const before = applied[applied.length - 1].settings;
    const edl = panel.one('olv-quality-advanced').findByClass('olv-quality-check')[0].byTag('input')[0];
    expect(edl.checked).toBe(false);
    edl.checked = true;
    edl.fire('change');

    const after = applied[applied.length - 1].settings;
    expect(after.edlEnabled).toBe(true);
    expect(after.antialiasing).toBe(before.antialiasing);
    expect(after.maxPixelRatio).toBe(before.maxPixelRatio);
    expect(after.streamingQuality).toBe(before.streamingQuality);
    expect(panel.one('olv-quality-position').ownText).toBe('Speed · adjusted');
  });

  it('keeps an earlier pin when a second knob is pinned', async () => {
    const { panel, applied } = await openPanel({ auto: false, position: QUALITY_MIN, overrides: {} });
    const checks = panel.one('olv-quality-advanced').findByClass('olv-quality-check');
    for (const check of checks) {
      const input = check.byTag('input')[0];
      input.checked = true;
      input.fire('change');
    }
    const settings = applied[applied.length - 1].settings;
    expect(settings.edlEnabled).toBe(true);
    expect(settings.antialiasing).toBe(true);
  });

  it('re-derives the streaming budget when a preset chip is pinned', async () => {
    const { panel, applied } = await openPanel({ auto: false, position: QUALITY_MIN, overrides: {} });
    const presets = panel.one('olv-quality-advanced').findByClass('olv-quality-chips')[0];
    presets.children[2].click(); // High
    const settings = applied[applied.length - 1].settings;
    expect(settings.streamingQuality).toBe('high');
    expect(settings.streamingPointBudget).toBeGreaterThan(applied[0].settings.streamingPointBudget);
  });

  it('hands the position back with "Follow the slider"', async () => {
    const { panel, applied } = await openPanel({
      auto: false,
      position: QUALITY_MIN,
      overrides: { edlEnabled: true },
    });
    const follow = panel.one('olv-quality-follow');
    expect(follow.disabled).toBe(false);
    follow.click();
    expect(applied[applied.length - 1].settings.edlEnabled).toBe(false);
    expect(follow.disabled).toBe(true);
  });

  it('adopts a preset chosen in the Streaming panel when it next opens', async () => {
    let live: 'low' | 'balanced' | 'high' = 'balanced';
    const { control, root, applied } = await makeControl(
      { auto: false, position: QUALITY_MIN, overrides: {} },
      () => live,
    );
    expect(applied[0].settings.streamingQuality).toBe('low');
    live = 'high';
    await control.open();
    const chips = root.one('olv-quality-advanced').findByClass('olv-quality-chips')[0];
    expect(chips.children[2].classList.contains('olv-chip-active')).toBe(true);
  });
});

describe('Speed ↔ Quality control — honesty', () => {
  it('states that nothing here reaches a computed quantity', async () => {
    const { panel } = await openPanel();
    const note = panel.one('olv-quality-note').ownText;
    expect(note).toContain('Display and streaming only');
    expect(note).toContain('Measurements');
    expect(note).toContain('exports');
  });
});
