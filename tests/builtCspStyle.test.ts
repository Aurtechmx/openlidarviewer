/**
 * builtCspStyle.test.ts: the post-build check that every inline <style> in the
 * built index.html is named by each enforcing CSP in index.html, _headers and
 * .htaccess.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cspStyleProblems, styleHash } from '../scripts/check-built-csp.mjs';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const policies = (): Record<string, string> => ({
  'index.html': read('index.html'),
  'public/_headers': read('public/_headers'),
  'public/.htaccess': read('public/.htaccess'),
});
const style = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;

describe('check-built-csp', () => {
  it('passes the source index.html against its own policies', () => {
    expect(cspStyleProblems(read('index.html'), read('index.html'), policies())).toEqual([]);
  });

  it('fails in every policy file when a build step changes the style text', () => {
    const src = read('index.html');
    const changed = src.replace(style(src), `${style(src)}\n`);
    const problems = cspStyleProblems(changed, src, policies());
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain(styleHash(style(changed)));
  });

  it('fails when the built page has no inline style', () => {
    const src = read('index.html');
    const stripped = src.replace(/<style>[\s\S]*?<\/style>/, '');
    expect(cspStyleProblems(stripped, src, policies())).toEqual([
      'the built index.html has no inline <style>',
      'the built index.html has 0 inline <style> block(s); the source has 1',
    ]);
  });

  it('fails when the built page has a different number of styles', () => {
    const src = read('index.html');
    const doubled = src.replace('</head>', `<style>${style(src)}</style></head>`);
    expect(cspStyleProblems(doubled, src, policies())).toEqual([
      'the built index.html has 2 inline <style> block(s); the source has 1',
    ]);
  });

  it('checks every enforcing CSP line, not only the first', () => {
    const src = read('index.html');
    const ok = read('public/_headers').split('\n').find((l) => l.includes('Content-Security-Policy:'))!;
    const bad = ok.replace(/'sha256-[^']+'/, "'sha256-AAAA'");
    const problems = cspStyleProblems(src, src, { two: `${ok}\n${bad}` });
    expect(problems).toEqual([`two: policy 2 style-src does not list ${styleHash(style(src))}`]);
  });

  it('fails when a policy file has no enforcing CSP', () => {
    const src = read('index.html');
    expect(cspStyleProblems(src, src, { x: '# Content-Security-Policy comment only' })).toEqual([
      'x: no Content-Security-Policy found',
    ]);
  });

  it('exits 1 and says no build was found when dist has no index.html', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olv-csp-'));
    try {
      const r = spawnSync(process.execPath, ['scripts/check-built-csp.mjs', dir], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('No build found');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
