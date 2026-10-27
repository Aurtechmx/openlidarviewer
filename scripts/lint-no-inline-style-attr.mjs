#!/usr/bin/env node
/**
 * lint-no-inline-style-attr.mjs
 *
 * The shipped CSP (index.html meta, public/_headers) has no 'unsafe-inline' in
 * style-src, so the browser drops a `style` attribute that script writes into
 * the page. Checked in Chromium against that CSP:
 *
 *   blocked: el.setAttribute('style', ...) on HTML and SVG elements, and a
 *            `style="..."` attribute in markup given to innerHTML or
 *            insertAdjacentHTML.
 *   allowed: el.style.cssText = ..., el.style = '...', el.style.setProperty(...)
 *            (CSSOM), and classes in the stylesheet.
 *
 * This fails on the blocked forms in src/ (tests excluded). Comments are
 * masked first. ALLOWED lists files whose `style="` text never reaches the
 * page DOM.
 *
 * Usage: `node scripts/lint-no-inline-style-attr.mjs` (npm run lint:no-inline-style-attr).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, sep } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SRC = join(ROOT, 'src');

const ALLOWED = new Map([
  // Builds the text of a downloaded .svg contour file; never parsed into the page.
  ['src/terrain/contour/svgContours.ts', 'downloaded SVG file text'],
]);

const PATTERNS = [
  { re: /\.setAttribute(?:NS)?\(\s*(?:null\s*,\s*|[^,()]*,\s*)?['"`]style['"`]/g, what: "setAttribute('style', ...)" },
  { re: /\bstyle\s*=\s*\\?["']/g, what: 'style="..." in markup' },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs|html)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** Blank out comments, keeping line breaks so line numbers hold. */
function maskComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
}

const files = walk(SRC);
const failures = [];
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  if (ALLOWED.has(rel)) continue;
  const text = maskComments(readFileSync(file, 'utf8'));
  for (const { re, what } of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      failures.push(`${rel}:${line}: ${what} is blocked by the page CSP; use a stylesheet class or el.style`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  console.error(`lint-no-inline-style-attr: ${failures.length} violation(s) in ${files.length} files`);
  process.exit(1);
}
console.log(`lint-no-inline-style-attr: ${files.length} files clean`);
