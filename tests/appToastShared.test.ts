/**
 * The measurement CSV export and the app shell share one toast element.
 *
 * With no `notify` injected, the export shows its message on `appToast()`,
 * the same singleton main.ts binds as its toast, so the page never holds two
 * `.olv-lasso-toast` elements.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { appToast } from '../src/ui/panelChrome';
import { exportMeasurementsFile, type MeasurementExportActionDeps } from '../src/app/measurementExportActions';
import * as serializers from '../src/export/measurementExport';
import type { Measurement } from '../src/render/measure/types';

class FakeEl {
  className = '';
  readonly dataset: Record<string, string> = {};
  type = '';
  textContent = '';
  readonly children: FakeEl[] = [];
  readonly attrs = new Map<string, string>();
  readonly classes = new Set<string>();
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(n: string, v: string): void { this.attrs.set(n, v); }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  addEventListener(): void {}
  get classList() {
    const c = this.classes;
    return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), contains: (x: string) => c.has(x) };
  }
}

const body = new FakeEl('body');

beforeAll(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
    body,
  };
});

afterAll(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

const distance: Measurement = {
  id: 'm1',
  kind: 'distance',
  name: 'd',
  points: [[0, 0, 0], [3, 4, 0]],
} as unknown as Measurement;

function deps(): MeasurementExportActionDeps {
  return {
    measure: {
      getMeasurements: () => [distance],
      worldUp: [0, 0, 1],
      unitToMetres: 1,
      verticalUnitToMetres: 1,
      crsKnown: true,
      geographicCrs: false,
    },
    geo: () => ({ origin: [0, 0, 0], crsName: 'WGS 84 / UTM zone 13N', name: 'site.laz' }),
    baseName: (n) => n.replace(/\.[^.]+$/, ''),
    downloadText: () => undefined,
    loadMeasurementExport: async () => ({
      ...serializers,
      resolveExportDigests: async () => ({ sourceSha256: null, sourceSha256Note: 'not supplied', crsOrigin: null } as never),
    }),
    loadMeasurementReport: async () => { throw new Error('unused'); },
    activeClassificationEpoch: () => 0,
    appVersion: '0.0.0',
    now: () => '2026-01-01T00:00:00.000Z',
  };
}

describe('the CSV export toast', () => {
  it('uses the one app toast element, naming the CSV and its sidecar', async () => {
    await exportMeasurementsFile('csv', deps());
    const toasts = body.children.filter((c) => c.className === 'olv-lasso-toast');
    expect(toasts).toHaveLength(1);
    const text = toasts[0].children.map((c) => c.textContent).join(' ');
    expect(text).toContain('site-measurements.csv');
    expect(text).toContain('site-measurements.provenance.txt');
    // The shell's toast (main.ts binds `appToast().show`) writes into the same element.
    appToast().show('Lasso hint');
    expect(body.children).toHaveLength(1);
    expect(body.children[0]).toBe(toasts[0]);
    expect(toasts[0].children[0].textContent).toBe('Lasso hint');
  });
});
