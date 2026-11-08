/**
 * watershedStrings.test.ts: the English/Spanish catalog for the watershed
 * study, its number formatting and its compass words.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  FIXED_NUMBER_KEYS,
  compassOf,
  formatArea,
  formatNumber,
  t,
  type StringKey,
} from '../src/simulation/flowPulse/watershed/watershedStrings';

const keys = Object.keys(CATALOG.en) as StringKey[];
const FORBIDDEN = /validated|certified|design flow|survey-grade|validad|certificad|caudal de diseño|—/i;

describe('watershed catalog', () => {
  it('has every key in both languages', () => {
    expect(keys.length).toBeGreaterThan(50);
    expect(Object.keys(CATALOG.es).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(CATALOG.en[k].trim().length, k).toBeGreaterThan(0);
      expect(CATALOG.es[k].trim().length, k).toBeGreaterThan(0);
    }
  });

  it('uses the same parameters in both languages', () => {
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const k of keys) expect(params(CATALOG.es[k]), k).toEqual(params(CATALOG.en[k]));
  });

  it('never emits a number in a template that is not a parameter', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const k of keys) {
        if (FIXED_NUMBER_KEYS.has(k)) continue;
        const names = [...CATALOG[lang][k].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        const params: Record<string, string> = {};
        names.forEach((n) => { params[n] = 'PARAM'; });
        const out = t(lang, k, params);
        expect(out, `${lang}:${k}`).not.toMatch(/\d/);
        expect(out, `${lang}:${k}`).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('keeps certainty and design language and em dashes out of every string', () => {
    for (const lang of ['en', 'es'] as const) {
      for (const k of keys) expect(CATALOG[lang][k], `${lang}:${k}`).not.toMatch(FORBIDDEN);
    }
  });

  it('says a culvert or pipe may pass here on the check-on-site text', () => {
    expect(t('en', 'checkOnSite.body', { area: 'A', depth: 'D' })).toContain('a culvert or pipe may pass here');
    expect(t('es', 'checkOnSite.body', { area: 'A', depth: 'D' })).toMatch(/alcantarilla o tubo/);
  });

  it('throws on a missing parameter', () => {
    expect(() => t('en', 'checkOnSite.body', {})).toThrow();
  });

  it('labels the verdicts', () => {
    expect([t('en', 'verdict.supported'), t('en', 'verdict.limited'), t('en', 'verdict.not-supported')])
      .toEqual(['Supported', 'Limited', 'Not supported']);
    expect([t('es', 'verdict.supported'), t('es', 'verdict.limited'), t('es', 'verdict.not-supported')])
      .toEqual(['Respaldado', 'Limitado', 'Sin respaldo']);
  });
});

describe('formatNumber', () => {
  it('formats 2067.4 as "2 067,4" in Spanish and "2,067.4" in English', () => {
    expect(formatNumber('es', 2067.4, 1)).toBe('2 067,4');
    expect(formatNumber('en', 2067.4, 1)).toBe('2,067.4');
  });
  it('rounds and keeps small numbers ungrouped', () => {
    expect(formatNumber('es', 0.031, 3)).toBe('0,031');
    expect(formatNumber('en', 412, 0)).toBe('412');
    expect(formatNumber('en', -1234567.891, 2)).toBe('-1,234,567.89');
  });
});

describe('formatArea', () => {
  it('uses hectares above 1 ha and square metres below', () => {
    expect(formatArea('en', 48_200)).toBe('4.82\u00a0ha');
    expect(formatArea('es', 48_200)).toBe('4,82\u00a0ha');
    expect(formatArea('en', 310)).toBe('310\u00a0m²');
    expect(formatArea('es', 4_310, 'minimum')).toBe('≥ 4\u00a0310\u00a0m²');
  });
});

describe('compassOf', () => {
  it('names eight points with north up', () => {
    expect(compassOf(0, 1, 'en')).toBe('north');
    expect(compassOf(1, 1, 'en')).toBe('north-east');
    expect(compassOf(-1, -1, 'es')).toBe('suroeste');
    expect(compassOf(-1, 0, 'es')).toBe('oeste');
    expect(compassOf(1, -0.1, 'en')).toBe('east');
  });
});

describe('Spanish terms', () => {
  it('pairs cuenca de aportación with cuenca del levantamiento', () => {
    expect(t('es', 'glossary.catchment.term')).toBe('Cuenca de aportación');
    expect(t('es', 'glossary.watershed.term')).toBe('Cuenca del levantamiento');
    for (const k of keys) expect(CATALOG.es[k], k).not.toMatch(/cuenca(s)? (de drenaje|estudiada)/i);
  });
});
