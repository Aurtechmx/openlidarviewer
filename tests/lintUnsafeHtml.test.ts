/**
 * lintUnsafeHtml.test.ts
 *
 * Pins the unsafeHtml/innerHTML injection-sink guard: it must flag a user- or
 * file-derived string reaching innerHTML, and must NOT flag the static-icon
 * usages the app actually ships. Guards the guard so a future refactor can't
 * quietly defang it.
 */
import { fileURLToPath } from 'node:url';

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
    expect(scanSource(`el('p', { unsafeHtml: annotationText });`)).toHaveLength(1);
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

describe('lint-unsafe-html — wider sinks and multi-line values', () => {
  it('flags a user-data identifier on a later line of a multi-line unsafeHtml value', () => {
    const bad = [
      `el('div', {`,
      `  unsafeHtml: \`<b>`,
      `    \${cloud.name}`,
      `  </b>\`,`,
      `});`,
    ].join('\n');
    const offenders = scanSource(bad, 'x.ts');
    expect(offenders).toHaveLength(1);
    expect(offenders[0].line).toBe(2);
  });

  it('flags a user-data identifier after a string that contains //', () => {
    const bad = `node.innerHTML = 'http://' + metadata.crs.wkt;`;
    expect(scanSource(bad, 'x.ts')).toHaveLength(1);
  });

  it.each([
    ['insertAdjacentHTML', `host.insertAdjacentHTML('beforeend', '<i></i>');`, 'insertAdjacentHTML'],
    ['outerHTML', `node.outerHTML = '<i></i>';`, 'outerHTML'],
    ['createContextualFragment', `const f = range.createContextualFragment('<i></i>');`, 'createContextualFragment'],
    ['DOMParser', `const doc = new DOMParser().parseFromString(xml, 'text/xml');`, 'DOMParser'],
    ['document.write', `document.write('<i></i>');`, 'document.write'],
  ])('refuses an unlisted %s even with a static value', (_name, source, sink) => {
    const offenders = scanSource(source, 'src/new/file.ts');
    expect(offenders.map((o: { token: string }) => o.token)).toContain(`unlisted ${sink}`);
  });

  it('flags a user-data identifier in an insertAdjacentHTML argument, listed or not', () => {
    const bad = `el.insertAdjacentHTML('beforeend', \`<p>\${annotationText}</p>\`);`;
    const tokens = scanSource(bad, 'src/ui/MeasurePanel.ts').map((o: { token: string }) => o.token);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toMatch(/^unlisted/);
  });

  it('accepts the reviewed MeasurePanel insertAdjacentHTML and only that call', () => {
    const ok = `overlayEl.insertAdjacentHTML('beforeend', html);`;
    expect(scanSource(ok, 'src/ui/MeasurePanel.ts')).toEqual([]);
    expect(scanSource(ok, 'src/ui/Other.ts')).toHaveLength(1);
    expect(scanSource(`overlayEl.insertAdjacentHTML('beforeend', other);`, 'src/ui/MeasurePanel.ts')).toHaveLength(1);
  });

  it('ignores sinks that appear only in comments', () => {
    const commented = [
      `// document.write('<b>' + fileName)`,
      `/* node.outerHTML = wkt; new DOMParser() */`,
      `/**`,
      ` * x.insertAdjacentHTML('beforeend', annotation)`,
      ` */`,
    ].join('\n');
    expect(scanSource(commented, 'src/x.ts')).toEqual([]);
  });

  it('keeps a division or a regex from being read as a comment or string', () => {
    const src = [
      `const r = a / b; const q = /'/.test(s);`,
      `node.innerHTML = ICON; // trailing`,
      `const p = x.insertAdjacentHTML('beforeend', annotationHtml);`,
    ].join('\n');
    expect(scanSource(src, 'src/ui/MeasurePanel.ts')).toHaveLength(1);
  });

  it('finds no unlisted sink and no user data in the shipped source', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.tsx?$/.test(n) ? [join(d, n)] : []));
    const offenders = walk(root).flatMap((f) =>
      scanSource(readFileSync(f, 'utf8'), f.slice(root.length - 3)),
    );
    expect(offenders).toEqual([]);
  });
});

describe('file-header text reaching a markup sink', () => {
  it.each([
    'el.innerHTML = vlr.description;',
    'el.innerHTML = `<b>${header.comments.join()}</b>`;',
    'el.innerHTML = node.name;',
    'el.innerHTML = layer.name;',
    'el.innerHTML = source.url;',
    'el.innerHTML = streamUrl;',
  ])('flags %s', (code) => {
    expect(scanSource(code).length).toBe(1);
  });

  it('leaves a constant icon alone', () => {
    expect(scanSource("el.innerHTML = '<svg></svg>';")).toEqual([]);
  });
});
