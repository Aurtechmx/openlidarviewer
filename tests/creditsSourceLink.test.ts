/**
 * creditsSourceLink.test.ts: the credits page names the source of the build
 * that is running, not the default branch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sourceRefFor, stampSourceLinks } from '../scripts/lib/sourceLink.mjs';

describe('credits source link', () => {
  it('points at the build commit', () => {
    expect(sourceRefFor({ version: '0.7.0', commit: 'abc1234', dirty: false })).toEqual({
      url: 'https://github.com/aurtechmx/openlidarviewer/tree/abc1234',
      label: ' (v0.7.0, commit abc1234)',
    });
  });

  it('says so when the build had local changes', () => {
    expect(sourceRefFor({ version: '0.7.0', commit: 'abc1234', dirty: true }).label).toContain('with local changes');
  });

  it('falls back to the release tag when the commit is unknown', () => {
    expect(sourceRefFor({ version: '0.7.0', commit: 'unknown', dirty: false }).url).toMatch(/\/tree\/v0\.7\.0$/);
  });

  it('rewrites every source link on the committed credits page', () => {
    const html = readFileSync('public/credits.html', 'utf8');
    const out = stampSourceLinks(html, { version: '0.7.0', commit: 'abc1234', dirty: false });
    const links = [...out.matchAll(/<a data-olv-source href="([^"]*)"/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l).toBe('https://github.com/aurtechmx/openlidarviewer/tree/abc1234');
    expect(out).toContain('<span data-olv-source-label> (v0.7.0, commit abc1234)</span>');
  });
});
