/**
 * flowDrainageSheetDialog.test.ts: the Drainage sheet dialog's checkboxes
 * decide the sections the builder draws, and the Lab offers the button.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

class FakeEl {
  className = ''; textContent = ''; type = ''; checked = false; disabled = false; tagName: string;
  readonly dataset: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly handlers: Record<string, (() => void)[]> = {};
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(): void {}
  getAttribute(): string | null { return null; }
  append(c: FakeEl | string): void { if (typeof c !== 'string') this.children.push(c); }
  addEventListener(t: string, h: () => void): void { (this.handlers[t] ??= []).push(h); }
  fire(t: string): void { for (const h of this.handlers[t] ?? []) h(); }
  all(): FakeEl[] { return this.children.flatMap((c) => [c, ...c.all()]); }
}

beforeAll(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: (t: string) => new FakeEl(t) };
  g.HTMLInputElement = FakeEl;
  g.HTMLAnchorElement = class {};
});

const { drainageSheetDialog, drainageSheetOptions, verticalToMetresOf } = await import('../src/ui/fieldSimulation/flowDrainageSheetDialog');

function open(hasPath: boolean, catchmentReason: string | null = null) {
  let picked: Record<string, boolean> | null = null;
  const root = drainageSheetDialog({ hasPath, hasCatchment: false, catchmentReason, onExport: (s) => { picked = s; }, onCancel: () => {} }) as unknown as FakeEl;
  const boxes = root.all().filter((e) => e.className === 'olv-flow-drainage-opt');
  const exportBtn = root.all().find((e) => e.className === 'olv-flow-drainage-export')!;
  return { boxes, exportBtn, picked: () => picked, root };
}

describe('the drainage sheet dialog', () => {
  it('ticks every available section and exports what stays ticked', () => {
    const d = open(true);
    expect(d.boxes.map((b) => [b.dataset.section, b.checked])).toEqual([
      ['map', true], ['summary', true], ['catchment', true], ['traced', true], ['depressions', true],
    ]);
    d.boxes[3]!.checked = false;
    d.exportBtn.fire('click');
    expect(d.picked()).toEqual({ map: true, summary: true, catchment: true, traced: false, depressions: true });
  });

  it('disables the traced and catchment boxes with their reasons', () => {
    const d = open(false, 'The run uses raw terrain; switch to Priority-Flood conditioned.');
    const traced = d.boxes.find((b) => b.dataset.section === 'traced')!;
    const catchment = d.boxes.find((b) => b.dataset.section === 'catchment')!;
    expect(traced.disabled && !traced.checked).toBe(true);
    expect(catchment.disabled && !catchment.checked).toBe(true);
    const reasons = d.root.all().filter((e) => e.className === 'olv-flow-drainage-reason').map((e) => e.textContent);
    expect(reasons.join(' ')).toContain('Trace a path');
    expect(reasons.join(' ')).toContain('raw terrain');
  });

  it('disables Export when nothing is ticked', () => {
    const d = open(true);
    for (const b of d.boxes) { b.checked = false; b.fire('change'); }
    expect(d.exportBtn.disabled).toBe(true);
  });

  it('passes the ticked sections to the builder and refuses a stale run', () => {
    const sections = { map: false, summary: true, catchment: false, traced: false, depressions: true };
    const base = { outcome: { ok: false } as never, stale: false, path: null, catchment: null, basename: 's', georef: null, rainfall: null, snappedFrom: null, linearUnit: 'metre' as const, sections };
    expect(drainageSheetOptions(base).ok).toBe(false);
    const ok = drainageSheetOptions({ ...base, outcome: { ok: true, grid: { cols: 3 } } as never });
    expect(ok.ok && ok.options.sections).toEqual(sections);
    expect(drainageSheetOptions({ ...base, outcome: { ok: true, grid: { cols: 3 } } as never, stale: true }).ok).toBe(false);
  });

  it('converts the vertical unit only when it is known', () => {
    expect(verticalToMetresOf('m', 'unknown')).toBe(1);
    expect(verticalToMetresOf('ft', 'foot')).toBe(0.3048);
    expect(verticalToMetresOf('ft', 'unknown')).toBeNull();
    expect(verticalToMetresOf('units', 'metre')).toBeNull();
  });
});

describe('the Lab', () => {
  it('offers Drainage sheet (PDF) beside Drainage in 3D, loaded lazily', () => {
    const src = readFileSync('src/ui/fieldSimulation/flowPulseLab.ts', 'utf8');
    expect(src).toContain("button('Drainage sheet (PDF)', 'olv-flow-drainage-sheet'");
    expect(src).toMatch(/overlayToggle\] : \[\]\),\s*drainageButton,/);
    expect(src).toContain('await loadFlowDrainageSheet()');
    expect(src).not.toMatch(/from '\.\.\/\.\.\/export\/flowDrainageSheetPdf'/);
  });
});
