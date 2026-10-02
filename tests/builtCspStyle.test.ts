/**
 * builtCspStyle.test.ts: the post-build check that every inline <style> in the
 * built index.html is named by the CSP in index.html, _headers and .htaccess.
 */
import { readFileSync } from 'node:fs';
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
    expect(cspStyleProblems(read('index.html'), policies())).toEqual([]);
  });

  it('fails in every policy file when a build step changes the style text', () => {
    const src = read('index.html');
    const changed = src.replace(style(src), `${style(src)}\n`);
    const problems = cspStyleProblems(changed, policies());
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain(styleHash(style(changed)));
  });

  it('fails when a policy file has no enforcing CSP', () => {
    expect(cspStyleProblems(read('index.html'), { x: '# Content-Security-Policy comment only' })).toEqual([
      'x: no Content-Security-Policy found',
    ]);
  });
});
