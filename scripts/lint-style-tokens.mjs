#!/usr/bin/env node
/**
 * lint-style-tokens.mjs: a shrink-only ratchet on colour literals and px font
 * sizes written outside the token sheet.
 *
 * Every colour and type size the interface uses is meant to come from
 * `src/styles/01-tokens.css`, so a theme or a contrast fix is made once. The
 * stylesheets still hold literals from before the tokens existed. This lint
 * counts them per file and fails when any file holds more than its banked
 * count, or when a file that is not banked holds any. A file may only go down.
 *
 * Counting method (COMMUNITY_SPEC.md §2): every `.css` file under `src/`
 * except `01-tokens.css`, with comments removed. A colour literal is a hex
 * colour (`#` and 3 to 8 hex digits) or an `rgb()`, `rgba()`, `hsl()` or
 * `hsla()` call, counted in declaration values only, so an id selector such as
 * `#add` is never read as a colour. A px font size is a `font` or `font-size`
 * declaration whose value holds a px length.
 *
 * `--update` banks a drop and refuses a raise, the same rule as
 * `lint-monolith-size.mjs`: a raise is only ever a hand edit to the baseline,
 * visible in review.
 */

import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = resolve(ROOT, 'docs/validation/style-tokens-baseline.json');
const TOKENS = 'src/styles/01-tokens.css';

const HEX = /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g;
const FUNC = /\b(?:rgba?|hsla?)\(/gi;
const PX_FONT = /^\s*font(?:-size)?\s*:(.*)$/is;

/** Every stylesheet the rule governs, as repo-relative paths. */
function cssFiles(dir = resolve(ROOT, 'src')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...cssFiles(full));
    else if (name.endsWith('.css')) out.push(relative(ROOT, full).split('\\').join('/'));
  }
  return out.filter((f) => f !== TOKENS).sort();
}

/** Colour literals and px font sizes in one stylesheet's text. */
export function countStyleLiterals(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let colours = 0;
  let pxFonts = 0;
  // Declarations sit between `{`, `;` and `}`; a selector never has a value.
  for (const segment of text.split(/[{};]/)) {
    const colon = segment.indexOf(':');
    if (colon < 0) continue;
    const value = segment.slice(colon + 1);
    // A selector segment (`a:hover`) ends at `{`, so it reaches here only as a
    // pseudo-class; it holds no hex or colour call and adds nothing.
    colours += (value.match(HEX) ?? []).length + (value.match(FUNC) ?? []).length;
    const m = PX_FONT.exec(segment);
    if (m && /\d(?:\.\d+)?px\b/.test(m[1])) pxFonts += 1;
  }
  return { colours, pxFonts };
}

/** Per-file counts for the whole tree, with the files at zero left out. */
export function measure() {
  const files = {};
  for (const f of cssFiles()) {
    const c = countStyleLiterals(readFileSync(resolve(ROOT, f), 'utf8'));
    if (c.colours > 0 || c.pxFonts > 0) files[f] = c;
  }
  return files;
}

/** Files above their banked counts, or unbanked files holding any literal. */
export function collectGrowth(current, baseline) {
  const grown = [];
  for (const [file, c] of Object.entries(current)) {
    const b = baseline.files?.[file] ?? { colours: 0, pxFonts: 0 };
    for (const key of ['colours', 'pxFonts']) {
      if (c[key] > b[key]) grown.push({ file, key, current: c[key], allowed: b[key] });
    }
  }
  return grown;
}

const total = (files, key) => Object.values(files).reduce((a, c) => a + c[key], 0);
const describe = (g) => `${g.file}: ${g.current} ${g.key === 'colours' ? 'colour literals' : 'px font sizes'}, banked ${g.allowed}. Use a token from ${TOKENS}.`;

if (isCliEntry(import.meta.url)) {
  const current = measure();
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  const update = process.argv.includes('--update');
  if (baseline === null && !update) {
    console.error(`lint:style-tokens FAILED\n\n  ${relative(ROOT, BASELINE)} is missing. Restore it from git.`);
    process.exit(1);
  }
  const grown = baseline ? collectGrowth(current, baseline) : [];
  if (update) {
    if (grown.length > 0) {
      console.error('lint:style-tokens --update REFUSED\n');
      for (const g of grown) console.error(`  • ${describe(g)}`);
      console.error('\n--update banks a drop, never a raise. A deliberate raise is a hand edit to the baseline.');
      process.exit(1);
    }
    const out = {
      $comment: 'Shrink-only. Colour literals and px font sizes per stylesheet outside 01-tokens.css; see scripts/lint-style-tokens.mjs. Bank a drop with `node scripts/lint-style-tokens.mjs --update`.',
      totals: { colours: total(current, 'colours'), pxFonts: total(current, 'pxFonts') },
      files: current,
    };
    writeFileSync(BASELINE, `${JSON.stringify(out, null, 2)}\n`);
    console.log(`style-tokens baseline written: ${out.totals.colours} colour literals, ${out.totals.pxFonts} px font sizes.`);
    process.exit(0);
  }
  if (grown.length > 0) {
    console.error('lint:style-tokens FAILED\n');
    for (const g of grown) console.error(`  • ${describe(g)}`);
    process.exit(1);
  }
  const colours = total(current, 'colours');
  const pxFonts = total(current, 'pxFonts');
  const drop = baseline.totals.colours - colours + (baseline.totals.pxFonts - pxFonts);
  console.log(
    `lint:style-tokens OK: ${colours} colour literals, ${pxFonts} px font sizes outside ${TOKENS}`
    + (drop > 0 ? ` (${drop} fewer than banked; run --update to bank it)` : '')
    + '.',
  );
}
