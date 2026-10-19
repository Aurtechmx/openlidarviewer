/**
 * lint:csp-html compares each shipped page's inline <script> and <style> with
 * the policy that ships, block by block. A policy that lists some hash does not
 * allow every block.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lintPages, readMirroredPolicy } from '../scripts/lint-csp-html.mjs';
import { hashSource, inlineProblems } from '../scripts/lib/cspInline.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p: string): string => readFileSync(`${ROOT}${p}`, 'utf8');
const policy = (read('public/.htaccess').match(/Header always set Content-Security-Policy "([^"]+)"/) ?? [])[1]!;

const STYLE = 'body{margin:0}';
const page = (head: string): string => `<!doctype html><html><head>${head}</head><body></body></html>`;

describe('inlineProblems', () => {
  it('flags an inline style whose hash the policy does not list, even though the policy lists another hash', () => {
    expect(policy).toMatch(/style-src[^;]*'sha256-/);
    const problems = inlineProblems('p.html', page(`<style>${STYLE}</style>`), policy);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(hashSource(STYLE));
    expect(problems[0]).toContain('style-src');
  });

  it('passes the same style once its hash is in the policy', () => {
    const withHash = policy.replace("style-src 'self'", `style-src 'self' ${hashSource(STYLE)}`);
    expect(inlineProblems('p.html', page(`<style>${STYLE}</style>`), withHash)).toEqual([]);
  });

  it('matches the hash of the exact text, whitespace included', () => {
    const withHash = policy.replace("style-src 'self'", `style-src 'self' ${hashSource(STYLE)}`);
    expect(inlineProblems('p.html', page(`<style>${STYLE}\n</style>`), withHash)).toHaveLength(1);
  });

  it('flags an inline script the policy does not list, and ignores external and data scripts', () => {
    const html = page(
      '<script>alert(1)</script><script src="a.js"></script><script type="application/ld+json">{"a":1}</script>',
    );
    const problems = inlineProblems('p.html', html, policy);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('inline <script>');
  });

  it("allows inline blocks under 'unsafe-inline' only when the policy has no hash or nonce", () => {
    const open = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'";
    expect(inlineProblems('p.html', page('<script>1</script><style>a{}</style>'), open)).toEqual([]);
    const pinned = "default-src 'self'; style-src 'self' 'unsafe-inline' 'sha256-AAAA'";
    expect(inlineProblems('p.html', page('<style>a{}</style>'), pinned)).toHaveLength(1);
  });

  it('accepts a script carrying a nonce the policy names', () => {
    const p = "default-src 'self'; script-src 'nonce-abc123'";
    expect(inlineProblems('p.html', page('<script nonce="abc123">1</script>'), p)).toEqual([]);
    expect(inlineProblems('p.html', page('<script nonce="other">1</script>'), p)).toHaveLength(1);
  });

  it('ignores markup inside comments', () => {
    expect(inlineProblems('p.html', page(`<!-- <style>${STYLE}</style> -->`), policy)).toEqual([]);
  });

  it('flags inline event handlers and javascript: URLs under a policy with no unsafe-inline', () => {
    const problems = inlineProblems('p.html', page('<a href="javascript:void 0" onclick="x()">a</a>'), policy);
    expect(problems.map((p) => p.includes('event handler') || p.includes('javascript:'))).toEqual([true, true]);
  });
});

describe('the shipped pages', () => {
  it('pass the shipped policy', () => {
    const pages = {
      'index.html': read('index.html'),
      'public/credits.html': read('public/credits.html'),
    };
    expect(lintPages(policy, readMirroredPolicy(), pages)).toEqual([]);
  });

  it('credits.html loads its styles from a file, not an inline <style>', () => {
    const html = read('public/credits.html');
    expect(html).not.toMatch(/<style\b/i);
    expect(html).toContain('<link rel="stylesheet" href="credits.css"');
    expect(read('public/credits.css')).toContain('color-scheme: dark');
  });

  it('would have failed the previous credits.html, whose inline style no policy named', () => {
    const inline = `<style>${read('public/credits.css')}</style>`;
    const html = read('public/credits.html').replace(/<link rel="stylesheet" href="credits.css"[^>]*>/, inline);
    expect(lintPages(policy, readMirroredPolicy(), { 'public/credits.html': html })).toHaveLength(1);
  });
});
