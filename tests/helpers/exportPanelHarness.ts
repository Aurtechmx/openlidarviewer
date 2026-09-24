/**
 * exportPanelHarness.ts
 *
 * Shared recording-DOM stub and ExportPanel wiring for the node-environment
 * ExportPanel tests (`exportPanelLegacyClassWrap.test.ts`,
 * `exportPanelWrapPreviewLoadFailure.test.ts`): a minimal fake element that
 * tracks class list, children and listeners, plus the small set of query /
 * drive helpers those tests share (building a classified cloud, clicking a
 * format pill, finding/toggling a checkbox row, constructing the panel).
 */

import { expect } from 'vitest';
import { PointCloud } from '../../src/model/PointCloud';

export class FakeEl {
  className = '';
  title = '';
  type = '';
  href = '';
  value = '';
  placeholder = '';
  inputMode = '';
  checked = false;
  disabled = false;
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly _listeners: Record<string, (() => void)[]> = {};
  readonly classList = {
    _set: new Set<string>(),
    add: (c: string): void => { this.classList._set.add(c); },
    remove: (c: string): void => { this.classList._set.delete(c); },
    toggle: (c: string, force?: boolean): void => {
      const on = force ?? !this.classList._set.has(c);
      if (on) this.classList._set.add(c);
      else this.classList._set.delete(c);
    },
    contains: (c: string): boolean => this.classList._set.has(c),
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName.toUpperCase(); }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* icons only */ }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  append(...kids: FakeEl[]): void { this.children.push(...kids.filter(Boolean)); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  addEventListener(type: string, fn: () => void): void {
    (this._listeners[type] ??= []).push(fn);
  }
  fire(type: string): void {
    for (const fn of this._listeners[type] ?? []) fn();
  }
  findByClass(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this.className.split(/\s+/).includes(cls)) out.push(this);
    for (const c of this.children) out.push(...c.findByClass(cls));
    return out;
  }
  /** Hidden by the global utility class, however it was applied. */
  get hidden(): boolean {
    return this.classList.contains('olv-hidden') || this.className.split(/\s+/).includes('olv-hidden');
  }
}

/** Install the fake `document` + element constructors the panel touches. */
export function installFakeDom(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
}

/** A classified point cloud, one point per class code, at a real-world origin. */
export function classifiedCloud(classes: number[], name = 'survey.las'): PointCloud {
  return new PointCloud({
    positions: new Float32Array(classes.length * 3).map((_, i) => i),
    origin: [500000, 4100000, 0],
    classification: Uint8Array.from(classes),
    sourceFormat: 'las',
    name,
  });
}

/** Click the format pill whose label is exactly `label`. */
export function pickFormat(root: FakeEl, label: string): void {
  const pill = root.findByClass('olv-bc-pill').find((p) => p.textContent === label);
  expect(pill, `format pill ${label} missing`).toBeDefined();
  pill!.fire('click');
}

/** The checkbox row whose label reads `text`. */
export function checkRow(root: FakeEl, text: string): FakeEl | undefined {
  return root.findByClass('olv-export-fullres').find((r) => r.textContent.includes(text));
}

export function setCheckbox(root: FakeEl, text: string, on: boolean): void {
  const label = root.findByClass('olv-export-fullres-label').find((l) => l.textContent.includes(text));
  expect(label, `checkbox "${text}" missing`).toBeDefined();
  const box = label!.children[0];
  box.checked = on;
  box.fire('change');
}

export const exportStatus = (root: FakeEl): FakeEl => root.findByClass('olv-export-status')[0];
export const exportNote = (root: FakeEl): FakeEl => root.findByClass('olv-export-summary-note')[0];

/** Construct a real `ExportPanel` against the fake DOM, returning its root element. */
export async function panelFor(
  display: PointCloud,
  extra: Record<string, unknown> = {},
): Promise<FakeEl> {
  const { ExportPanel } = await import('../../src/ui/ExportPanel');
  const panel = new ExportPanel({
    getCloud: () => display,
    hasFullSource: () => false,
    isReduced: () => false,
    getFullCloud: async () => null,
    ...extra,
  });
  return panel.element as unknown as FakeEl;
}

/** Drain a handful of microtask ticks, e.g. for a lazily loaded chunk to settle. */
export async function settleTicks(count = 6): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((r) => setTimeout(r, 0));
}
