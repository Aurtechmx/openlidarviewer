/**
 * workbenchNamePanelExport.test.ts
 *
 * The docked Profile Workbench's two new controls: the editable title, and
 * Export PDF.
 *
 * ONE NAME, NOT TWO. A profile is named in the Measurements list, in the dock
 * title and on the exported sheet, and the only way those three can agree is
 * for none of them to keep a copy. The dock therefore commits a typed name
 * straight through to the host and shows back whatever the host kept; the
 * assertions below are that it holds no name of its own and invents none.
 *
 * ONE SHEET, NOT TWO. The dock's export runs the host's promise. It builds
 * nothing and knows nothing about what goes on a profile sheet, which is what
 * makes a sheet exported from the dock the same sheet, with the same read
 * scope and the same classification basis, as one exported from the panel.
 * `profilePdfInputFor` is where that assembly lives, and the last test here
 * puts its output through the real builder to read the sentence back off the
 * page.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createProfileWorkbenchLauncher } from '../src/app/profileWorkbenchLauncher';
import { profilePdfInputFor } from '../src/ui/profilePdfInput';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import {
  buildProfileProvenance,
  describeProfileProvenance,
} from '../src/render/measure/profileProvenance';
import { NON_GROUND_CLASSES } from '../src/terrain/ground/classificationFilter';
import type { ProfileWorkbenchHandle, ProfileWorkbenchHost } from '../src/ui/ProfileWorkbench';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { ProfileChartSample } from '../src/render/measure/types';

// ─────────────────────────────────────────────────────────────────────────────
// A DOM small enough to hold in one hand
// ─────────────────────────────────────────────────────────────────────────────

class FakeEl {
  className = '';
  title = '';
  type = '';
  value = '';
  disabled = false;
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly attrs: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners: { type: string; fn: (ev: unknown) => void }[] = [];
  readonly classList = {
    add: (): void => {},
    remove: (): void => {},
    contains: (): boolean => false,
    toggle: (): void => {},
  };
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  setAttribute(n: string, v: string): void {
    this.attrs[n] = v;
  }
  getAttribute(n: string): string | null {
    return n in this.attrs ? this.attrs[n] : null;
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids.filter(Boolean));
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.append(...kids);
  }
  remove(): void {}
  contains(): boolean {
    return false;
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.push({ type, fn });
  }
  removeEventListener(): void {}
  focus(): void {}
  blur(): void {}
  setPointerCapture(): void {}
  releasePointerCapture(): void {}
  getContext(): null {
    return null;
  }
  dispatch(type: string): void {
    for (const l of [...this.listeners]) if (l.type === type) l.fn({ type, target: this });
  }
  tree(): FakeEl[] {
    return [this as FakeEl, ...this.children.flatMap((c) => c.tree())];
  }
  byClass(cls: string): FakeEl | undefined {
    return this.tree().find((n) => n.className.split(/\s+/).includes(cls));
  }
  byText(text: string): FakeEl | undefined {
    return this.tree().find((n) => n.textContent === text);
  }
}

class FakeHost implements ProfileWorkbenchHost {
  readonly root = new FakeEl('div');
  container(): HTMLElement {
    return this.root as unknown as HTMLElement;
  }
  stageHeight(): number {
    return 1000;
  }
  onStageResize(): () => void {
    return () => {};
  }
  notifyDockHeight(): void {}
  prefersReducedMotion(): boolean {
    return true;
  }
}

beforeEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement: (tag: string) => new FakeEl(tag),
    createElementNS: (_ns: string, tag: string) => new FakeEl(tag),
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  };
  g.HTMLInputElement = class {};
  g.HTMLAnchorElement = class {};
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.HTMLInputElement;
  delete g.HTMLAnchorElement;
});

/** Open a dock through the real launcher and hand back what it produced. */
async function openDock(deps: {
  rename?: (id: string, name: string) => void;
  exportPdf?: (id: string) => Promise<void>;
  name?: string;
}): Promise<{ root: FakeEl; handle: ProfileWorkbenchHandle }> {
  const host = new FakeHost();
  const module = await import('../src/ui/ProfileWorkbench');
  const launcher = createProfileWorkbenchLauncher({
    load: () => Promise.resolve(module),
    stage: { host: () => host, canDock: () => true, release: () => {} },
    ...(deps.rename ? { rename: deps.rename } : {}),
    ...(deps.exportPdf ? { exportPdf: deps.exportPdf } : {}),
  });
  const opened = await launcher.open({
    id: 'm-1',
    kind: 'profile',
    name: deps.name ?? 'Profile 2',
  });
  expect(opened).toBe(true);
  const handle = launcher.handle;
  if (!handle) throw new Error('the launcher must hold the dock it mounted');
  return { root: handle.element as unknown as FakeEl, handle };
}

describe('the dock is titled by the measurement it is plotting', () => {
  it('opens showing the measurement name, not a generic panel word', async () => {
    const { root } = await openDock({ rename: () => {} });
    const field = root.byClass('olv-workbench-title-input');
    expect(field).toBeDefined();
    expect(field!.value).toBe('Profile 2');
    expect(root.getAttribute('aria-label')).toBe('Profile 2');
  });

  it('is a plain caption where the host wired no way to record a name', async () => {
    const { root } = await openDock({});
    expect(root.byClass('olv-workbench-title-input')).toBeUndefined();
    expect(root.byClass('olv-workbench-title')?.textContent).toBe('Profile 2');
  });

  it('commits a typed name through the host, keyed on the measurement id', async () => {
    const renamed: [string, string][] = [];
    const { root } = await openDock({ rename: (id, name) => renamed.push([id, name]) });
    const field = root.byClass('olv-workbench-title-input')!;
    field.value = '  North levee  ';
    field.dispatch('change');
    // Trimmed on the way out, and carrying the id the dock was opened for.
    expect(renamed).toEqual([['m-1', 'North levee']]);
    expect(field.value).toBe('North levee');
    expect(root.getAttribute('aria-label')).toBe('North levee');
  });

  it('refuses a blank name and restores the one something else still holds', async () => {
    const renamed: string[] = [];
    const { root } = await openDock({ rename: (_id, name) => renamed.push(name) });
    const field = root.byClass('olv-workbench-title-input')!;
    field.value = '   ';
    field.dispatch('change');
    expect(renamed).toEqual([]);
    expect(field.value).toBe('Profile 2');
  });

  it('takes a name from the host without calling back for it', async () => {
    // The panel-side rename lands here. Echoing it back through `onRename`
    // would be a rename loop over a name the controller already holds.
    const renamed: string[] = [];
    const { root, handle } = await openDock({ rename: (_id, name) => renamed.push(name) });
    handle.setTitle?.('Renamed elsewhere');
    expect(root.byClass('olv-workbench-title-input')!.value).toBe('Renamed elsewhere');
    expect(renamed).toEqual([]);
  });
});

describe('the dock exports the sheet the host builds', () => {
  it('renders no export control where the host offered no export', async () => {
    const { root } = await openDock({});
    expect(root.byText('Export PDF')).toBeUndefined();
  });

  it('runs the host export for the measurement it is plotting', async () => {
    const asked: string[] = [];
    const { root } = await openDock({
      exportPdf: (id) => {
        asked.push(id);
        return Promise.resolve();
      },
    });
    const btn = root.byText('Export PDF');
    expect(btn).toBeDefined();
    btn!.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toEqual(['m-1']);
    expect(btn!.textContent).toBe('Export PDF');
    expect(btn!.disabled).toBe(false);
  });

  it('reports a failed export on the control that was pressed', async () => {
    const { root } = await openDock({ exportPdf: () => Promise.reject(new Error('no')) });
    const btn = root.byText('Export PDF')!;
    btn.dispatch('click');
    await Promise.resolve();
    await Promise.resolve();
    expect(btn.textContent).toBe('Export failed');
    expect(btn.disabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What lands on the page
// ─────────────────────────────────────────────────────────────────────────────

function ramp(n: number): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i < n; i++) out.push({ distance: i * 2, height: 100 + i * 0.4 });
  return out;
}

/** The drawn strings of a sheet, rejoined across the builder's line breaks. */
function drawnPdfProse(bytes: Uint8Array): string {
  const parts: string[] = [];
  let inflated = '';
  const raw = Buffer.from(bytes).toString('latin1');
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      inflated += inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      inflated += m[1]!;
    }
  }
  for (const m of inflated.matchAll(/<([0-9A-Fa-f]+)>/g)) {
    parts.push(Buffer.from(m[1]!, 'hex').toString('latin1'));
  }
  return parts.join(' ');
}

/** A resident-only read with classification missing on one source. */
function provenanceRecord() {
  return buildProfileProvenance({
    capturedAt: '2026-01-01T00:00:00.000Z',
    up: [0, 0, 1],
    sources: [
      {
        slot: 0,
        layerId: 'urn:layer:alpha',
        displayName: 'Alpha flight',
        classification: 'absent',
        streaming: true,
      },
    ],
    accepted: { count: 2, sourceSlot: [0, 0] },
    excludedClasses: NON_GROUND_CLASSES,
    units: { linearUnit: 'metre', verticalReference: 'unknown', verticalMetresPerUnit: 1 },
  });
}

function summaryNamed(name: string): MeasurementSummary {
  return {
    id: 'm-1',
    kind: 'profile',
    name,
    value: '482.0 m',
    profileChart: ramp(16),
    profileChartResidentOnly: true,
    profileCorridorWidthM: 12.5,
    profileGroundPercentile: 25,
    profileDatumKnown: false,
    profileProvenance: provenanceRecord(),
  } as unknown as MeasurementSummary;
}

describe('the exported sheet carries the name and the provenance', () => {
  const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

  it('prints the renamed profile on the sheet', async () => {
    const input = profilePdfInputFor(summaryNamed('North levee'), {
      context: { crs: 'EPSG:2225 - NAD83 / California zone 1 (ftUS)', verticalDatum: null },
      unitSystem: 'metric',
      generatedAt: FIXED_DATE,
    });
    expect(input.name).toBe('North levee');
    const text = drawnPdfProse(await buildProfilePdf(input));
    expect(text).toContain('North levee');
  });

  it('carries the read scope AND the classification basis of the heights', async () => {
    const record = provenanceRecord();
    const sentence = describeProfileProvenance(record);
    // The clause that is easiest to lose and worst to lose: what the heights
    // were classified on. A sheet without it reads as a clean ground surface.
    expect(sentence).toContain('classification missing on a source');

    const input = profilePdfInputFor(summaryNamed('North levee'), {
      context: null,
      unitSystem: 'metric',
      generatedAt: FIXED_DATE,
    });
    expect(input.provenance).not.toBeNull();
    const text = drawnPdfProse(await buildProfilePdf(input));
    expect(text).toContain(sentence);
    expect(text).toContain('classification missing on a source');
  });

  it('passes every parameter the app knows, not a subset', async () => {
    const input = profilePdfInputFor(summaryNamed('North levee'), {
      context: { crs: 'EPSG:6340 - NAD83(2011) / UTM zone 11N', verticalDatum: 'NAVD88' },
      unitSystem: 'imperial',
      generatedAt: FIXED_DATE,
    });
    expect(input.crs).toBe('EPSG:6340 - NAD83(2011) / UTM zone 11N');
    expect(input.verticalDatum).toBe('NAVD88');
    expect(input.unitSystem).toBe('imperial');
    expect(input.corridorWidthM).toBe(12.5);
    expect(input.groundPercentile).toBe(25);
    expect(input.residentOnly).toBe(true);
    // A conflicting render origin means these are LOCAL heights, and the sheet
    // must not print the word elevation over them.
    expect(input.datumKnown).toBe(false);
    expect(input.generatedAt).toBe(FIXED_DATE);
  });
});

describe('there is one assembly of the sheet, not one per control', () => {
  /**
   * Read as source rather than exercised through the panel.
   *
   * What has to hold is a property of the FILE: that no control anywhere in it
   * reaches the builder with inputs of its own. Driving one control cannot
   * show that, because the second assembly is exactly the one the driven
   * control does not use, and that is how the CRS and the provenance came to
   * be missing from every sheet once before.
   */
  const source = readFileSync(
    fileURLToPath(new URL('../src/ui/MeasurePanel.ts', import.meta.url)),
    'utf8',
  );

  it('reaches the builder from a single call site', () => {
    const calls = source.match(/\bbuildProfilePdf\s*\(/g) ?? [];
    expect(calls.length).toBe(1);
  });

  it('reaches it through the shared assembly, never with a literal of its own', () => {
    const at = source.indexOf('buildProfilePdf(');
    expect(at).toBeGreaterThan(0);
    expect(source.slice(at, at + 200)).toContain('profilePdfInputFor(');
  });

  it('exposes the export by id, which is the route the dock takes', () => {
    expect(source).toContain('async exportProfilePdf(id: string): Promise<void>');
  });
});
