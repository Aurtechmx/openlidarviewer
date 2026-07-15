/**
 * mapSheetExportOptions.test.ts
 *
 * Pure defaults + sanitisation for the pre-export MAP PDF dialog.
 */

import { describe, it, expect } from 'vitest';
import {
  SHEET_OPTIONS,
  ORIENTATION_OPTIONS,
  sanitizeMapFilename,
  ensurePdfExtension,
  defaultMapTitle,
  defaultMapNotes,
  defaultMapFilename,
} from '../src/render/measure/mapSheetExportOptions';

describe('option lists', () => {
  it('offers Letter / A4 / A3 and Portrait / Landscape', () => {
    expect(SHEET_OPTIONS.map((o) => o.value)).toEqual(['letter', 'a4', 'a3']);
    expect(ORIENTATION_OPTIONS.map((o) => o.value)).toEqual(['portrait', 'landscape']);
  });
});

describe('sanitizeMapFilename', () => {
  it('strips path separators and reserved characters', () => {
    expect(sanitizeMapFilename('../etc/pa:ss?wd')).toBe('etcpasswd');
    expect(sanitizeMapFilename('a\\b/c')).toBe('abc');
    expect(sanitizeMapFilename('na<m>e"|*?')).toBe('name');
  });

  it('drops a trailing .pdf (re-added at download)', () => {
    expect(sanitizeMapFilename('site-map.pdf')).toBe('site-map');
    expect(sanitizeMapFilename('site-map.PDF')).toBe('site-map');
  });

  it('collapses whitespace to single hyphens and trims junk ends', () => {
    expect(sanitizeMapFilename('  el  picacho  ')).toBe('el-picacho');
    expect(sanitizeMapFilename('--site..')).toBe('site');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeMapFilename('')).toBe('contours-map');
    expect(sanitizeMapFilename('///')).toBe('contours-map');
    expect(sanitizeMapFilename('   ', 'fallback')).toBe('fallback');
  });
});

describe('ensurePdfExtension', () => {
  it('adds .pdf when missing', () => {
    expect(ensurePdfExtension('site-map')).toBe('site-map.pdf');
  });
  it('keeps exactly one .pdf and normalises case', () => {
    expect(ensurePdfExtension('site-map.pdf')).toBe('site-map.pdf');
    expect(ensurePdfExtension('site-map.PDF')).toBe('site-map.pdf');
  });
});

describe('defaultMapTitle', () => {
  it('prefers the host context title', () => {
    expect(defaultMapTitle({ title: 'El Picacho — Contours', basename: 'picacho' })).toBe(
      'El Picacho — Contours',
    );
  });
  it('derives from basename when no title', () => {
    expect(defaultMapTitle({ title: null, basename: 'picacho' })).toBe('picacho — Contours');
    expect(defaultMapTitle({ basename: '' })).toBe('Contours');
  });
});

describe('defaultMapNotes', () => {
  it('describes source, interval, and CRS — metre vertical reads "m"', () => {
    expect(
      defaultMapNotes({
        basename: 'picacho',
        intervalM: 10,
        crs: 'WGS 84 / UTM zone 11N',
        verticalUnitToMetres: 1,
      }),
    ).toBe('Contours from picacho · interval 10 m · WGS 84 / UTM zone 11N');
  });
  it('labels a foot vertical unit as "ft"', () => {
    expect(
      defaultMapNotes({
        basename: 'picacho',
        intervalM: 2,
        crs: 'NAD83 / California zone 6 (ftUS)',
        verticalUnitToMetres: 1200 / 3937,
      }),
    ).toBe('Contours from picacho · interval 2 ft · NAD83 / California zone 6 (ftUS)');
  });
  it('marks the interval "unverified" when the vertical unit is unknown — never a false "m"', () => {
    const notes = defaultMapNotes({ basename: 'picacho', intervalM: 10, crs: 'no CRS' });
    expect(notes).toBe('Contours from picacho · interval 10 (vertical unit unverified) · no CRS');
    expect(notes).not.toMatch(/interval 10 m\b/);
  });
  it('says "no CRS" when unknown and "auto" when no interval', () => {
    expect(defaultMapNotes({ basename: 'scan', intervalM: null, crs: null })).toBe(
      'Contours from scan · interval auto · no CRS',
    );
  });
});

describe('defaultMapFilename', () => {
  it('is a sanitised <basename>-map', () => {
    expect(defaultMapFilename('El Picacho')).toBe('El-Picacho-map');
    expect(defaultMapFilename('')).toBe('contours-map');
  });
});
