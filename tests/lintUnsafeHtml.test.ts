/**
 * lintUnsafeHtml.test.ts
 *
 * Pins the unsafeHtml/innerHTML injection-sink guard: it must flag a user- or
 * file-derived string reaching innerHTML, and must NOT flag the static-icon
 * usages the app actually ships. Guards the guard so a future refactor can't
 * quietly defang it.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no type declarations.
import { scanSource } from '../scripts/lint-unsafe-html.mjs';

describe('lint-unsafe-html scanSource', () => {
  it('flags a filename flowing into unsafeHtml', () => {
    const bad = `el('div', { unsafeHtml: \`<b>\${cloud.name}</b>\` });`;
    const offenders = scanSource(bad, 'x.ts');
    expect(offenders).toHaveLength(1);
  });

  it('flags a CRS WKT string assigned to innerHTML', () => {
    const bad = `node.innerHTML = '<span>' + metadata.crs.wkt + '</span>';`;
    expect(scanSource(bad, 'x.ts').length).toBeGreaterThan(0);
  });

  it('flags an annotation string reaching the sink', () => {
    expect(scanSource(`el('p', { unsafeHtml: annotationText });`).length).toBe(1);
  });

  it('does NOT flag static icon constants (the real usages)', () => {
    const ok = [
      `el('span', { unsafeHtml: ICON_SVG[name] });`, // static icon by key
      `button.append(el('span', { unsafeHtml: icon }));`,
      `ico.innerHTML = fitnessIcon(d.key);`,
      `unsafeHtml: KIND_ICON[k] + '<span class="olv-mkind-name">Undo</span>',`,
      `this.element.innerHTML = fs ? ICON_EXIT : ICON_ENTER;`,
    ].join('\n');
    expect(scanSource(ok, 'ok.ts')).toEqual([]);
  });

  it('ignores the chokepoint definition in dom.ts', () => {
    const def = `if (props.unsafeHtml !== undefined) node.innerHTML = props.unsafeHtml;`;
    expect(scanSource(def, 'dom.ts')).toEqual([]);
  });

  it('ignores a comment that merely mentions a denylisted token', () => {
    const commented = `// never pass cloud.name into unsafeHtml here\nel('b', { text: name });`;
    expect(scanSource(commented, 'c.ts')).toEqual([]);
  });
});
