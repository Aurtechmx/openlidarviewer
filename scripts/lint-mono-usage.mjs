#!/usr/bin/env node
/**
 * lint-mono-usage.mjs — one enforced font policy for the UI.
 *
 * The panels had drifted: `var(--mono)` (JetBrains Mono) was set ad-hoc in 50+
 * places across the stylesheet partitions following an informal "mono for data"
 * convention that the panels applied inconsistently, so two panels side by side
 * rendered in different fonts. The fix was to make every UI panel use the sans
 * body font (with tabular-nums for numeric alignment) and keep monospace only
 * where it is a real convention: keyboard keycaps and the raw debug overlay.
 *
 * This guard keeps it that way. `var(--mono)` is allowed ONLY inside the
 * allowlisted selectors below; anywhere else fails the release gate. The typo'd
 * `var(--olv-mono)` / `var(--mono-font)` (undefined variables that only render
 * monospace by accident of the CSS fallback string) are banned outright — the
 * one real token is `--mono`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = resolve(ROOT, 'src/styles');

// Selectors permitted to use the monospace token: keyboard keycaps (a standard
// convention) and the developer debug overlay (raw JSON is verbatim data).
const ALLOWED = [
  '.olv-palette-row-key',
  '.olv-palette-hint-key',
  '.olv-key',
  '.olv-cam-chip-key',
  '.olv-shortcuts-row-key',
  '.olv-shortcuts-hint-key',
  '.olv-debug-block',
];

const MONO_TOKEN = /var\(\s*--mono\s*\)/;
const BANNED_VARS = /var\(\s*--(olv-mono|mono-font)\b/;

const violations = [];
const bannedHits = [];

for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
  const lines = readFileSync(resolve(STYLES, file), 'utf8').split('\n');
  let selector = '';
  lines.forEach((line, i) => {
    if (line.includes('{')) {
      const s = line.split('{')[0].trim().replace(/,$/, '');
      if (s) selector = s;
    }
    if (BANNED_VARS.test(line)) {
      bannedHits.push(`${file}:${i + 1}  ${line.trim().slice(0, 70)}`);
    }
    if (MONO_TOKEN.test(line)) {
      const ok = ALLOWED.some((a) => selector.includes(a));
      if (!ok) violations.push(`${file}:${i + 1}  (${selector.slice(0, 40)})  ${line.trim().slice(0, 60)}`);
    }
  });
}

if (bannedHits.length || violations.length) {
  if (bannedHits.length) {
    console.error(`lint:mono-usage FAILED — undefined mono variables (use --mono, or the sans body font):`);
    for (const h of bannedHits) console.error(`  • ${h}`);
  }
  if (violations.length) {
    console.error(`lint:mono-usage FAILED — var(--mono) used outside the keycap / debug allowlist. UI panel text is the sans body font with tabular-nums; only keycaps and the debug overlay may be monospace:`);
    for (const v of violations) console.error(`  • ${v}`);
  }
  process.exit(1);
}

console.log(`lint:mono-usage OK — var(--mono) confined to ${ALLOWED.length} keycap/debug selectors; every panel uses the sans body font.`);
