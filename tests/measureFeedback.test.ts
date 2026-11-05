/**
 * Small measure-tool presses that used to change something, or nothing, without
 * a word: renaming a row, finishing too few points, switching kind with a
 * draft, and the units toggle on a scan whose units are unverified.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import type { Vec3 } from '../src/render/navMath';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom({ ns: true });
  (globalThis as { window?: unknown }).window ??= { addEventListener: () => {}, removeEventListener: () => {} };
});

function panelWithRow(onRename: (id: string, name: string) => void) {
  const panel = new MeasurePanel({ onDelete: () => {}, onRename, onCopy: () => {}, onExport: () => {}, onImport: () => {}, getUnitSystem: () => 'metric' });
  panel.update([{ id: 'a', kind: 'distance', name: 'Distance 1', value: '4 m' }] as MeasurementSummary[]);
  const row = (panel.element as unknown as FakeEl).querySelectorAll('.olv-mp-row')[0]!;
  const input = row.querySelectorAll('.olv-mp-name')[0]! as unknown as FakeEl & { value: string };
  return { row, input };
}

describe('renaming a measurement row', () => {
  it('a blank name puts back the last committed name, and a rename does not rebuild the row', () => {
    const onRename = vi.fn();
    const { row, input } = panelWithRow(onRename);
    input.value = '  Kerb ';
    input.dispatchEvent({ type: 'change' });
    expect(onRename).toHaveBeenCalledWith('a', 'Kerb');
    expect(input.value).toBe('Kerb');
    input.value = '   ';
    input.dispatchEvent({ type: 'change' });
    expect(input.value).toBe('Kerb');
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(row.querySelectorAll('.olv-mp-name')[0]).toBe(input);
  });

  it('updates the row buttons to the new name in place', () => {
    const { row, input } = panelWithRow(() => {});
    input.value = 'Kerb';
    input.dispatchEvent({ type: 'change' });
    expect(row.querySelectorAll('.olv-mp-del')[0]!.getAttribute('aria-label')).toBe('Delete Kerb');
    expect(row.querySelectorAll('.olv-mp-copy')[0]!.getAttribute('aria-label')).toBe('Copy Kerb');
  });

  it('tells the shell about both rename paths, so the result card follows', () => {
    const src = readFileSync(new URL('../src/app/measurePanelMount.ts', import.meta.url), 'utf8');
    expect(src.match(/renameMeasurement\(id, name\);[^\n]*\n?\s*deps\.onRenamed\?\.\(\)/g)?.length).toBe(2);
    expect(readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')).toMatch(/onRenamed: \(\) => clipFlow\.onMeasurementsChanged\(\)/);
  });
});

interface Internals {
  _draft: { kind: string; points: Vec3[] } | null;
  _newDraft(): { kind: string; points: Vec3[] };
  _hintEl: { textContent: string };
  _unitsBtn: FakeEl;
  _unitUnverified(): boolean;
}

async function make(kind: 'area' | 'polyline', points: Vec3[]) {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setActive(true);
  measure.setKind(kind);
  const inner = measure as unknown as Internals;
  const d = inner._newDraft();
  d.points = points;
  inner._draft = d;
  return { measure, inner };
}

const P: Vec3 = [0, 0, 0];
const Q: Vec3 = [1, 0, 0];

describe('too few points and a kind switch', () => {
  it('keeps the draft and says what is needed when finished too early', async () => {
    const { measure, inner } = await make('area', [P, Q]);
    measure.finishCurrent();
    expect(measure.getMeasurements()).toHaveLength(0);
    expect(inner._draft?.points).toHaveLength(2);
    expect(inner._hintEl.textContent).toBe('Needs at least 3 points: 2 placed. Click more, or press Esc to cancel.');
    measure.dispose();
  });

  it('says a draft was discarded on a kind switch, and stays quiet with none', async () => {
    const { measure, inner } = await make('polyline', [P, Q, [1, 1, 0]]);
    measure.setKind('area');
    expect(inner._draft).toBeNull();
    expect(inner._hintEl.textContent).toMatch(/^Previous polyline draft with 3 points discarded\. /);
    measure.setKind('polyline');
    expect(inner._hintEl.textContent).not.toMatch(/discarded/);
    measure.dispose();
  });
});

describe('units toggle', () => {
  it('explains why the figures did not change on unverified units, and only then', async () => {
    const { measure, inner } = await make('area', []);
    const notice = vi.fn();
    measure.onNotice = notice;
    const unverified = vi.spyOn(inner, '_unitUnverified').mockReturnValue(true);
    inner._unitsBtn.click();
    expect(notice).toHaveBeenCalledWith("Imperial saved. This scan's units are unverified, so its figures stay in source units until you set a CRS.");
    notice.mockClear();
    unverified.mockReturnValue(false);
    inner._unitsBtn.click();
    expect(notice).not.toHaveBeenCalled();
    measure.dispose();
  });
});
