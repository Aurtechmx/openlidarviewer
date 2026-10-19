/**
 * Only content-hashed files under assets/ may be cached as immutable for a
 * year. The .htaccess rule matches on the file name alone, so a root file whose
 * name merely looks hash-shaped (`brand-mark-light.svg`) was cached for a year
 * and could not be refreshed. _headers scopes the rule to /assets/*.
 */
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const htaccess = readFileSync(join(ROOT, 'public/.htaccess'), 'utf8');
const headers = readFileSync(join(ROOT, 'public/_headers'), 'utf8');

/** The FilesMatch blocks in file order: pattern and the Cache-Control they set. */
function cacheRules(): Array<{ re: RegExp; value: string }> {
  return [...htaccess.matchAll(/<FilesMatch\s+"([^"]+)">\s*Header set Cache-Control "([^"]+)"/g)].map((m) => ({
    re: new RegExp(m[1]!),
    value: m[2]!,
  }));
}

/** The Cache-Control .htaccess sends for a file name: the last matching rule wins. */
function htaccessCacheFor(name: string): string | undefined {
  return cacheRules().filter((r) => r.re.test(name)).pop()?.value;
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

describe('.htaccess caching', () => {
  it('finds the immutable rule', () => {
    expect(cacheRules().some((r) => /immutable/.test(r.value))).toBe(true);
  });

  it('caches brand-mark-light.svg for a day, not a year', () => {
    expect(htaccessCacheFor('brand-mark-light.svg')).not.toMatch(/immutable/);
    expect(htaccessCacheFor('brand-mark.svg')).not.toMatch(/immutable/);
  });

  it('marks no file shipped in public/ immutable', () => {
    const offenders = [...files(join(ROOT, 'public'))]
      .map((f) => ({ path: relative(join(ROOT, 'public'), f), name: f.split('/').pop()! }))
      .filter((f) => /immutable/.test(htaccessCacheFor(f.name) ?? ''))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('still caches a Vite-hashed bundle for a year', () => {
    for (const name of ['index-Bx3F9aQ2.js', 'OlvFont-Regular-Latin-8tf8FM3T.woff2', 'index-DaDnDjF_.css']) {
      expect(htaccessCacheFor(name)).toMatch(/immutable/);
    }
  });
});

describe('_headers caching', () => {
  it('scopes the immutable rule to /assets/*', () => {
    const blocks = headers.split(/\n(?=\/)/).filter((b) => /immutable/.test(b));
    expect(blocks.map((b) => b.split('\n')[0])).toEqual(['/assets/*']);
  });
});
