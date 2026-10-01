import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function headerCsp(): string {
  const line = read('public/_headers').split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
  if (!line) throw new Error('no CSP in public/_headers');
  return line.split('Content-Security-Policy:')[1]!.trim();
}

function metaCsp(): string | null {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(read('index.html'));
  return m ? m[1]! : null;
}

describe('index.html CSP meta', () => {
  it('mirrors public/_headers without frame-ancestors', () => {
    const expected = headerCsp()
      .split(';')
      .map((d) => d.trim())
      .filter((d) => d && !d.startsWith('frame-ancestors'))
      .join('; ');
    expect(metaCsp()).toBe(expected);
  });

  it('allows no inline script or style', () => {
    expect(metaCsp()).not.toContain("'unsafe-inline'");
    expect(headerCsp()).not.toContain("'unsafe-inline'");
  });

  it('names the sha256 of every inline <style> in index.html', () => {
    const blocks = [...read('index.html').matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      const hash = `'sha256-${createHash('sha256').update(b).digest('base64')}'`;
      expect(metaCsp()).toContain(hash);
      expect(headerCsp()).toContain(hash);
    }
  });

  it('comes before any script or stylesheet', () => {
    const html = read('index.html');
    const meta = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(meta).toBeGreaterThan(-1);
    expect(meta).toBeLessThan(html.indexOf('<style'));
    expect(meta).toBeLessThan(html.indexOf('<script'));
  });
});
