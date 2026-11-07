/**
 * watershedReportOptions.test.ts: defaults and sanitising for the watershed
 * report's export dialog.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_NOTES_CHARS,
  clampNotes,
  defaultReportFilename,
  defaultReportTitle,
  sanitizeReportFilename,
} from '../src/export/watershedReport/watershedReportOptions';

describe('defaultReportTitle', () => {
  it('uses the scan name, else the basename, else a fallback', () => {
    expect(defaultReportTitle({ scanName: '  North field  ', basename: 'scan-01' })).toBe('North field');
    expect(defaultReportTitle({ scanName: ' ', basename: 'scan-01' })).toBe('scan-01');
    expect(defaultReportTitle({ scanName: null, basename: '' })).toBe('Watershed report');
  });
});

describe('sanitizeReportFilename', () => {
  it('drops the extension, reserved characters and control codes and collapses spaces', () => {
    expect(sanitizeReportFilename('My  site: report?.PDF')).toBe('My-site-report');
    expect(sanitizeReportFilename('a/b\\c\u0007d')).toBe('abcd');
    expect(sanitizeReportFilename('..--name--..')).toBe('name');
  });

  it('falls back when nothing usable remains', () => {
    expect(sanitizeReportFilename('  /// ')).toBe('watershed-report');
    expect(sanitizeReportFilename('', 'x')).toBe('x');
  });
});

describe('defaultReportFilename', () => {
  it('names the file by basename and language', () => {
    expect(defaultReportFilename('site 01', 'en')).toBe('site-01-watershed-report-en.pdf');
    expect(defaultReportFilename('', 'es')).toBe('scan-watershed-report-es.pdf');
  });
});

describe('clampNotes', () => {
  it('collapses whitespace and control codes', () => {
    expect(clampNotes('  two\n\nlines\tand\u0000more  ')).toBe('two lines and more');
  });

  it('keeps short notes and cuts long ones at a word with an ellipsis', () => {
    expect(clampNotes('short note')).toBe('short note');
    const long = 'word '.repeat(200);
    const out = clampNotes(long);
    expect(out.length).toBeLessThanOrEqual(MAX_NOTES_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/ …$/);
  });
});
