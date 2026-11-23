/**
 * browserFloor.test.ts
 *
 * A browser older than the build's floor is told so plainly, and its parse
 * failure is not mistaken for a stale deploy that a reload would fix.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browserBelowFloor, classifyLoadError } from '../src/app/staleChunkReload';

describe('the browser floor', () => {
  it('marks a browser without CompressionStream or structuredClone as below the floor', () => {
    expect(browserBelowFloor({ CompressionStream: function () {}, structuredClone: () => 0 })).toBe(false);
    expect(browserBelowFloor({ structuredClone: () => 0 })).toBe(true);
    expect(browserBelowFloor({ CompressionStream: function () {} })).toBe(true);
    expect(browserBelowFloor()).toBe(false);
  });

  it('still classifies a missing chunk as stale in a supported browser', () => {
    expect(classifyLoadError(new TypeError('Importing a module script failed.'))).toBe('stale-chunk');
  });

  it('the page check uses the same features and loads before the app', () => {
    const check = readFileSync(join(process.cwd(), 'public', 'browser-check.js'), 'utf8');
    expect(check).toContain("typeof window.CompressionStream === 'function'");
    expect(check).toContain("typeof window.structuredClone === 'function'");
    expect(check).toContain("typeof window.WebGL2RenderingContext === 'function'");
    // Classic script syntax only: an old browser must be able to parse it.
    expect(check).not.toMatch(/=>|\blet\b|\bconst\b|`|\?\.|\?\?/);
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    expect(html.indexOf('/browser-check.js')).toBeGreaterThan(0);
    expect(html.indexOf('/browser-check.js')).toBeLessThan(html.indexOf('/src/main.ts'));
  });
});

describe('download links', () => {
  it('the session log page keeps its link as long as the shared helper does', async () => {
    const { DOWNLOAD_URL_LIFETIME_MS } = await import('../src/io/download');
    const page = readFileSync(join(process.cwd(), 'src', 'app', 'sessionLog', 'sessionLogPage.ts'), 'utf8');
    const m = page.match(/URL\.revokeObjectURL\(url\), ([\d_]+)\)/);
    expect(Number(m?.[1].replace(/_/g, ''))).toBe(DOWNLOAD_URL_LIFETIME_MS);
  });
});

describe('Apple touch devices', () => {
  const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', maxTouchPoints: 5 };
  const IPAD_DESKTOP = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 5 };
  const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', maxTouchPoints: 0 };
  const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130', maxTouchPoints: 10 };

  it('drops the picker filter on iPhone and iPad, keeps it elsewhere', async () => {
    const { pickerAccept } = await import('../src/ui/pickerAccept');
    expect(pickerAccept('.olvsession,application/json', IPHONE)).toBe('');
    expect(pickerAccept('.olvsession,application/json', IPAD_DESKTOP)).toBe('');
    expect(pickerAccept('.olvsession,application/json', MAC)).toBe('.olvsession,application/json');
    expect(pickerAccept('.las,.laz', WINDOWS)).toBe('.las,.laz');
  });

  it('every picker with a custom extension goes through the helper', () => {
    for (const f of ['src/app/actions/exportActions.ts', 'src/app/actions/workflowActions.ts', 'src/ui/BatchConverter.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      expect(src, f).toMatch(/\.accept = pickerAccept\(/);
      expect(src, f).not.toMatch(/\.accept = (?!pickerAccept)/);
    }
  });


});

describe('dropped folders', () => {
  it('leaves folders out and counts them; without entries nothing is filtered', async () => {
    const { withoutFolders, FOLDER_DROP_MESSAGE } = await import('../src/ui/DropZone');
    const a = { name: 'scan.laz' } as File;
    const dir = { name: 'Scans' } as File;
    const items = {
      length: 2,
      0: { webkitGetAsEntry: () => ({ isDirectory: false }) },
      1: { webkitGetAsEntry: () => ({ isDirectory: true }) },
    };
    expect(withoutFolders([a, dir], items)).toEqual({ files: [a], folders: 1 });
    expect(withoutFolders([a, dir], undefined)).toEqual({ files: [a, dir], folders: 0 });
    expect(withoutFolders([dir], { length: 1, 0: { webkitGetAsEntry: () => ({ isDirectory: true }) } })).toEqual({ files: [], folders: 1 });
    expect(FOLDER_DROP_MESSAGE).toMatch(/^A folder cannot be opened\./);
  });
});

describe('persistent storage for the signing key', () => {
  it('asks for it where offered and never throws', async () => {
    const { requestPersistentStorage } = await import('../src/export/reportSigningKeyStore');
    expect(await requestPersistentStorage({ persist: async () => true })).toBe(true);
    expect(await requestPersistentStorage({ persist: async () => { throw new Error('x'); } })).toBe(false);
    expect(await requestPersistentStorage({})).toBe(false);
    expect(await requestPersistentStorage(undefined)).toBe(false);
  });
});
