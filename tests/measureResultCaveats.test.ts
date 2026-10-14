/**
 * measureResultCaveats.test.ts: the Measurements panel, the compact result card
 * and the Copy text state the same scene caveats for the same measurement.
 *
 * The panel grades each row against the scene (shared datum, layer set,
 * vertical reference, vertical unit). The compact model has to be given the
 * same scene, or a height the panel calls approximate reads as a bare number.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../src/ui/ResultFocus', () => ({ openResultFocus: () => {} }));

import { MeasurePanel } from '../src/ui/MeasurePanel';
import { buildResultModel } from '../src/app/measureResultModel';
import { VOLUME_ESTIMATE_NOTICE } from '../src/render/measure/format';
import { VERTICAL_UNIT_BORROWED_NOTE, type MeasureSceneContext } from '../src/render/measure/measureConfidence';
import type { MeasurementSummary } from '../src/render/measure/MeasureController';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => {
  installFakeDom();
});

const green = { grade: 'green', caption: 'Well supported', reasons: [], presentable: true } as const;

const KNOWN: MeasureSceneContext = { datumResolved: true, layers: 'single', verticalReferenceKnown: true };
const NO_VERTICAL_DATUM: MeasureSceneContext = { ...KNOWN, verticalReferenceKnown: false };
const BORROWED: MeasureSceneContext = { ...KNOWN, verticalUnitBorrowed: true };

const height = (over: Partial<MeasurementSummary> = {}): MeasurementSummary =>
  ({ id: 'h1', kind: 'height', name: 'Height 1', value: '100.00 m', trust: green, ...over }) as MeasurementSummary;

function panelFor(s: MeasurementSummary, scene: MeasureSceneContext): FakeEl {
  const panel = new MeasurePanel({
    onDelete: () => {},
    onRename: () => {},
    onExport: () => {},
    onImport: () => {},
    getUnitSystem: () => 'metric',
  });
  panel.setConfidenceContext(scene);
  panel.update([s]);
  return panel.element as unknown as FakeEl;
}

describe('result card and Copy carry the panel\'s scene caveats', () => {
  it('a height with no known vertical reference is approximate in the panel, the card and Copy', () => {
    const s = height();
    const root = panelFor(s, NO_VERTICAL_DATUM);
    const line = root.querySelectorAll('.olv-mp-confidence')[0];
    expect(line.textContent).toBe('Viewer measurement · approximate');
    expect(line.title).toContain('vertical reference unknown');

    const m = buildResultModel(s, NO_VERTICAL_DATUM);
    expect(m.caveat).toContain('vertical reference unknown');
    expect(m.caveat).toContain(line.textContent);
    expect(m.copyText).toBe(`Height 1: 100.00 m (${m.caveat})`);
    expect(m.value).toBe('100.00 m');
  });

  it('an unresolved shared datum is stated on a distance, as the panel states it', () => {
    const s = { id: 'd1', kind: 'distance', name: 'Distance 1', value: '12.35 m', trust: green } as MeasurementSummary;
    const scene: MeasureSceneContext = { ...KNOWN, datumResolved: false };
    const line = panelFor(s, scene).querySelectorAll('.olv-mp-confidence')[0];
    const m = buildResultModel(s, scene);
    expect(line.title).toContain('shared datum unresolved');
    expect(m.caveat).toContain('shared datum unresolved');
    expect(m.copyText).toContain('shared datum unresolved');
  });

  it('a borrowed vertical unit is stated beside a height figure, as in the panel', () => {
    const s = height();
    const note = panelFor(s, BORROWED).querySelectorAll('.olv-mp-vunit-note')[0];
    expect(note.textContent).toBe(VERTICAL_UNIT_BORROWED_NOTE);
    const m = buildResultModel(s, BORROWED);
    expect(m.caveat).toBe(VERTICAL_UNIT_BORROWED_NOTE);
    expect(m.copyText).toBe(`Height 1: 100.00 m (${VERTICAL_UNIT_BORROWED_NOTE})`);
  });

  it('a horizontal measurement does not take the vertical caveats', () => {
    const s = { id: 'd1', kind: 'distance', name: 'Distance 1', value: '12.35 m', trust: green } as MeasurementSummary;
    expect(panelFor(s, { ...BORROWED, verticalReferenceKnown: false }).querySelectorAll('.olv-mp-vunit-note')).toHaveLength(0);
    const m = buildResultModel(s, { ...BORROWED, verticalReferenceKnown: false });
    expect(m.caveat).toBeNull();
    expect(m.copyText).toBe('Distance 1: 12.35 m');
  });

  it('a volume carries the estimate notice in the card and Copy, as in the panel', () => {
    const s = { id: 'v1', kind: 'volume', name: 'Pile A', value: '12.00 m³', trust: green } as MeasurementSummary;
    expect(panelFor(s, KNOWN).querySelectorAll('.olv-mp-volume-estimate')[0].textContent).toBe(VOLUME_ESTIMATE_NOTICE);
    const m = buildResultModel(s, KNOWN);
    expect(m.caveat).toBe(VOLUME_ESTIMATE_NOTICE);
    expect(m.copyText).toBe(`Pile A: 12.00 m³ (${VOLUME_ESTIMATE_NOTICE})`);
  });

  it('a fully established scene leaves a green height plain', () => {
    const m = buildResultModel(height(), KNOWN);
    expect(m.status).toBe('ok');
    expect(m.caveat).toBeNull();
    expect(m.copyText).toBe('Height 1: 100.00 m');
  });

  it('an unverified unit is stated once', () => {
    const s = height({ value: '100.00 units (unverified)', unitUnverified: true });
    const m = buildResultModel(s, { ...KNOWN, unitVerified: false });
    expect(m.status).toBe('unit-unverified');
    expect(m.caveat!.match(/unit unverified/g)).toHaveLength(1);
  });

  it('a layer set in incomparable frames is stated', () => {
    const m = buildResultModel(height(), { ...KNOWN, layers: 'incomparable' });
    expect(m.caveat).toContain('incomparable frames');
  });
});
