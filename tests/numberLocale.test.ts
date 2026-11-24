/**
 * numberLocale.test.ts
 *
 * A number is written the same way in every browser. A `toLocaleString` call
 * without a locale follows the browser's language, so one screen could show
 * 16.364 (grouped) beside 3.25 (decimal). Every call in src names its locale.
 * Dates shown on screen may follow the browser; they are listed below.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clipScopeText } from '../src/render/clip/clipScope';
import { mapScaleLabel } from '../src/render/measure/mapSheetPdf';
import { magnitudeFixed } from '../src/terrain/spaceMetrics';

/** On-screen dates and times in the reader's own format. This list only shrinks. */
const LOCAL_DATES: Readonly<Record<string, string>> = {
  'src/app/recovery/recoveryController.ts': '.toLocaleString()',
  'src/ui/QualityPanel.ts': '.toLocaleTimeString([]',
};

/** A call whose locale is missing, `undefined` or `[]`. Comments are not exempt. */
const HOST_LOCALE =
  /(?:\.toLocale(?:String|DateString|TimeString|UpperCase|LowerCase)\s*\(|\bIntl\.[A-Z]\w*\s*\()\s*(?:\)|,|undefined\b|\[\s*\])|\bnew\s+Intl\.[A-Z]\w*(?!\w|\s*\()/g;

function hostLocaleCalls(text: string): string[] {
  return text.match(HOST_LOCALE) ?? [];
}

function sources(dir: string): string[] {
  return readdirSync(join(process.cwd(), dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return sources(rel);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [rel] : [];
  });
}

describe('numbers name their locale', () => {
  it('no call in src leaves the locale to the browser, apart from the listed dates', () => {
    const files = sources('src');
    expect(files.length).toBeGreaterThan(500);
    const found: Record<string, string[]> = {};
    for (const f of files) {
      const calls = hostLocaleCalls(readFileSync(join(process.cwd(), f), 'utf8'));
      if (calls.length > 0) found[f] = calls;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(LOCAL_DATES).map(([f, c]) => [f, [c]])));
  });

  it('the scan sees each form and accepts a named locale', () => {
    for (const bad of [
      'n.toLocaleString()', 'n?.toLocaleString()', 'n.toLocaleString(undefined, {})', 'n\n.toLocaleString(\n)',
      'd.toLocaleDateString([])', 'd.toLocaleTimeString()', 's.toLocaleUpperCase()',
      'new Intl.NumberFormat()', 'Intl.NumberFormat(undefined)', 'new Intl.DateTimeFormat', '`${n.toLocaleString()}`',
    ]) expect(hostLocaleCalls(bad), bad).toHaveLength(1);
    for (const ok of ["n.toLocaleString('en-US')", 's.toLocaleUpperCase(tag)', "new Intl.NumberFormat('en-US')", 'new Intl.DateTimeFormat(lang, {})']) {
      expect(hostLocaleCalls(ok), ok).toEqual([]);
    }
  });
});

describe('in a browser set to German', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('screen and sheet numbers keep a comma for thousands', () => {
    const real = Number.prototype.toLocaleString;
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number, locale?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions,
    ) {
      return real.call(this, (locale ?? 'de-DE') as string, options);
    });
    expect((16364).toLocaleString()).toBe('16.364');
    expect(magnitudeFixed(16364, 2)).toBe('16,364');
    expect(mapScaleLabel(2400, 'metre')).toBe('1:2,400');
    expect(clipScopeText({ kept: 16739, total: 31839 } as Parameters<typeof clipScopeText>[0])).toContain('16,739 of 31,839');
  });
});
