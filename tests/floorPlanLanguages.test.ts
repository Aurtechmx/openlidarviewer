/**
 * floorPlanLanguages.test.ts
 *
 * The floor plan preview sheet in each export language: the catalog agrees
 * with English, the coded extraction notes said in English are the
 * extractor's own sentences, and a translated sheet keeps its warning lines
 * bold and its title block inside the box.
 */
import { describe, expect, it } from 'vitest';
import { EXPORT_LANGUAGES, languageInfo } from '../src/i18n/languages';
import { templateParams } from '../src/i18n/message';
import { FLOOR_PLAN_TEXT, type FloorPlanKey } from '../src/i18n/deliverables/floorPlan';
import { extractFloorPlan } from '../src/terrain/space/floorplan/extractFloorPlan';
import { englishPlanWords, floorPlanSvg, planNoteText } from '../src/terrain/space/floorplan/floorPlanSvg';

const OTHERS = EXPORT_LANGUAGES.map((l) => l.id).filter((id) => id !== 'en');

function room(W = 10, D = 8, H = 2.5, step = 0.1, partition = false): Float32Array {
  const t: number[] = [];
  for (let x = 0; x <= W; x += step) for (let y = 0; y <= D; y += step) t.push(x, y, 0, x, y, H);
  for (let z = 0; z <= H; z += step) for (let x = 0; x <= W; x += step) t.push(x, 0, z, x, D, z);
  for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) t.push(0, y, z, W, y, z);
  if (partition) for (let z = 0; z <= H; z += step) for (let y = 0; y <= D; y += step) if (y < 3 || y > 4) t.push(W / 2, y, z);
  return Float32Array.from(t);
}
const flat = (): Float32Array => {
  const t: number[] = [];
  for (let x = 0; x <= 6; x += 0.1) for (let y = 0; y <= 6; y += 0.1) t.push(x, y, 0);
  return Float32Array.from(t);
};

const MODELS = [
  extractFloorPlan(room(), { upAxis: 'z' }),
  extractFloorPlan(room(10, 8, 2.5, 0.1, true), { upAxis: 'z' }),
  extractFloorPlan(flat(), { upAxis: 'z' }),
  extractFloorPlan(room(), { upAxis: 'z', unitKnown: false }),
  extractFloorPlan(new Float32Array(30), { upAxis: 'z' }),
];

const bold = (svg: string): number => (svg.match(/font-weight="bold" fill="[^"]+">/g) ?? []).length;

describe('floor plan catalog', () => {
  const en = FLOOR_PLAN_TEXT.en;
  const keys = Object.keys(en) as FloorPlanKey[];
  it.each(OTHERS)('%s has every English entry with the same parameters, none empty', (lang) => {
    const cat = FLOOR_PLAN_TEXT[lang];
    expect(Object.keys(cat).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(cat[k].trim().length, k).toBeGreaterThan(0);
      expect(templateParams(cat[k]), k).toEqual(templateParams(en[k]));
    }
  });

  it('every coded note, said in English, is the sentence the extractor wrote', () => {
    const w = englishPlanWords();
    for (const m of MODELS) {
      expect(m.notes?.length).toBe(m.reasons.length);
      expect(m.notes!.map((n) => planNoteText(n, w))).toEqual(m.reasons);
    }
  });
});

describe('the floor plan sheet in each language', () => {
  it.each(OTHERS)('%s translates the sheet, keeps warnings bold and the title block in its box', (lang) => {
    const locale = { lang, numberStyle: languageInfo(lang).numberStyle };
    for (const m of MODELS) {
      const english = floorPlanSvg(m, { title: 'Room', dateText: '2026-06-05' });
      const svg = floorPlanSvg(m, { title: 'Room', dateText: '2026-06-05', locale });
      expect(svg).not.toMatch(/Orientation: local scan frame|not for construction|requires visual validation|Floor Plan Preview/);
      // A longer translation wraps onto more lines, each bold, so never fewer.
      expect(bold(svg)).toBeGreaterThanOrEqual(bold(english));
      if (m.wallRings.length > 0) expect(svg).toContain(FLOOR_PLAN_TEXT[lang].scaleRatio.split(' ')[0]);
    }
  });

  it('writes numbers in the chosen style', () => {
    const m = MODELS[0];
    const comma = floorPlanSvg(m, { title: 'Room', dateText: '2026-06-05', locale: { lang: 'es', numberStyle: 'comma' } });
    const point = floorPlanSvg(m, { title: 'Room', dateText: '2026-06-05', locale: { lang: 'es', numberStyle: 'point' } });
    expect(comma).toMatch(/\d,\d m \(\d+,\d ft\)/);
    expect(point).toMatch(/\d\.\d m \(\d+\.\d ft\)/);
  });

  it('puts the words back after a draw, so the next English sheet is English', () => {
    floorPlanSvg(MODELS[0], { title: 'Room', dateText: '2026-06-05', locale: { lang: 'de', numberStyle: 'comma' } });
    expect(floorPlanSvg(MODELS[0], { title: 'Room', dateText: '2026-06-05' })).toContain('Orientation: local scan frame');
  });
});
