/**
 * The external testing form hands the maintainer an HTML file built from a
 * stranger's typing and a stranger's filenames. Opening it is the moment the
 * escaping matters: a gap here is not an attack on the tester, it is an attack
 * on whoever reads the submission.
 *
 * These assertions exist because the form went out with no coverage at all,
 * and the escaping is the part of it that has a victim when it is wrong.
 *
 * Everything here runs against the shipped module, not a copy of it.
 */

// @ts-expect-error — plain JS shipped to the browser, no declaration file
import { buildHtmlReport, escapeHtml } from '../public/test-report-format.js';

const shot = (name: string) => ({ name, w: 800, h: 600, dataUrl: 'data:image/jpeg;base64,AAAA' });

describe('escapeHtml', () => {
  it('escapes the five characters that change parsing', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes the ampersand before anything else', () => {
    // Replacing < first and & second would turn &lt; into &amp;lt; and render
    // the literal text instead of the character. One pass over a character
    // class avoids it; this pins that it stays one pass.
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('neutralises a script tag rather than dropping it', () => {
    // Stripping would hide what the tester actually submitted. The report is
    // evidence, so it has to stay readable while being inert.
    const out = escapeHtml('<script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('&lt;script&gt;');
  });

  it('handles values that are not strings', () => {
    expect(escapeHtml(null)).toBe('null');
    expect(escapeHtml(undefined)).toBe('undefined');
    expect(escapeHtml(42)).toBe('42');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('CRS mismatch in the Z range')).toBe('CRS mismatch in the Z range');
  });
});

describe('buildHtmlReport', () => {
  it('puts the report inside a pre so its line breaks survive', () => {
    const html = buildHtmlReport('line one\nline two');
    expect(html).toContain('<pre>line one\nline two</pre>');
  });

  it('escapes the report body', () => {
    const html = buildHtmlReport('issue: <img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes a filename in both the attribute and the caption', () => {
    // A quote in a filename closes alt="..." early and everything after it
    // parses as markup. The picker accepts quotes, so this is reachable.
    const html = buildHtmlReport('body', [shot('orbit" onload="alert(1)')]);
    expect(html).not.toContain('onload="alert(1)"');
    expect(html).toContain('&quot;');
  });

  it('embeds each screenshot with its dimensions', () => {
    const html = buildHtmlReport('body', [shot('a.png'), shot('b.png')]);
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('(800x600)');
  });

  it('is a complete document with no screenshots', () => {
    // The send path always uses this wrapper, including when the tester
    // attached nothing. Raw text under an .html name renders as one collapsed
    // paragraph, which is why the wrapper is unconditional.
    const html = buildHtmlReport('just text');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<title>');
    expect(html).not.toContain('<img ');
  });

  it('defaults to no screenshots when none are passed', () => {
    expect(() => buildHtmlReport('body')).not.toThrow();
  });

  it('declares utf-8, so a report in any language survives the round trip', () => {
    const html = buildHtmlReport('medición de pendiente — 精度');
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('medición de pendiente — 精度');
  });
});
