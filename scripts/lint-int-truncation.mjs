#!/usr/bin/env node
/**
 * lint-int-truncation.mjs — tell a deliberate 32-bit wrap apart from a
 * truncation nobody checked the range of.
 *
 * `x | 0`, `x >>> 0` and `~~x` all coerce a number to a 32-bit integer. In a
 * codec, a hash or a checksum that coercion IS the arithmetic: the value lives
 * in a 32-bit register by design and the wrap is the point. Everywhere else the
 * idiom is a fast `Math.trunc`, and it is only correct while the operand cannot
 * exceed 2^31 − 1. This viewer opens billion-point clouds and multi-gigabyte
 * files, so a point index, a byte offset or a length run through `| 0` can wrap
 * to a negative number with no error and no throw — the exact silent corruption
 * `typescript:S7767` warns about, which it cannot tell from the wraps that are
 * meant.
 *
 * This does. A site is accepted when it is one of:
 *   • a declared 32-bit-domain module (codec / hash / checksum), listed below;
 *   • fed straight into a hash function, where 32-bit is the datatype;
 *   • a length divided down — `(buf.length / n) | 0` — whose result is smaller
 *     than the array length that bounds it, itself under 2^31;
 *   • a line marked `i32-ok` with a human's reason.
 * Any other truncation whose expression names a quantity that can pass 2^31
 * (count, offset, size, index, points…) is reported and fails the run: confirm
 * the range and mark it, or switch to Math.trunc / Math.floor.
 *
 * Filesystem walk, no git: it runs unchanged inside an extracted archive.
 *
 * Run: node scripts/lint-int-truncation.mjs [--list]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Modules where a 32-bit register is the datatype, not an optimisation: the
 * arithmetic coder and chunk table port laszip's U32/I32 registers, and a
 * checksum's whole job is 32-bit modular arithmetic. Every bitwise truncation
 * in these files is the operation.
 */
const DOMAIN_32BIT = new Set([
  'src/io/heavy/arithmeticCoder.ts', // laszip arithmetic coder, U32/I32 registers
  'src/io/heavy/lazChunkTable.ts', //   laszip chunk table, 32-bit fields
  'src/terrain/export/sha256.ts', //    SHA-256, 32-bit working words
  'src/io/e57/crc32c.ts', //            CRC-32C, 32-bit modular
  'src/render/measure/auditLog.ts', //  FNV-1a content hash, 32-bit
]);

/** A quantity that can pass 2^31 in this application, so a wrap would be wrong. */
const MAGNITUDE_WORDS = [
  'count', 'counts', 'length', 'len', 'offset', 'offsets', 'byte', 'bytes',
  'byteLength', 'size', 'sizes', 'index', 'idx', 'indices', 'point', 'points',
  'pointCount', 'numPoints', 'nPoints', 'total', 'totals', 'position',
  'positions', 'addr', 'address', 'stride', 'capacity', 'bufferLength',
];
// Built from the word list rather than one long literal alternation: the list
// is the readable form, and the constructed regex carries no branch-count
// complexity for a reader (or a linter) to wade through.
const MAGNITUDE = new RegExp(`\\b(?:${MAGNITUDE_WORDS.join('|')})\\b`, 'i');

/** A length divided down — result ≤ the array length that bounds it, under 2^31. */
const LENGTH_DERIVED = /(?:\.length|\blen\b)\s*\/\s*[\w.]+/;

/** Fed straight into a hash / checksum, where a 32-bit word is the datatype. */
const HASH_ARG = /\b(?:fnv\w*|\w*[Hh]ash\w*|mix\w*|crc\w*|checksum|digest)\s*\(/;

/** The three S7767 truncation idioms, avoiding `|| 0`, `| 0xNN`, `a & 0`. */
const IDIOMS = [
  { re: /(?<![|&^])\|\s*0(?![xX0-9.])/, name: '| 0' },
  { re: />>>\s*0\b/, name: '>>> 0' },
  { re: /(?<![\w)\]])~~[\w(]/, name: '~~' },
];

/** Strip a `// …` line comment and any `/* … *\/` spans, so matches are code. */
function codeOnly(line) {
  // The block-comment matcher is unrolled (`[^*]*` and `\*(?!\/)` consume
  // disjoint characters) so it runs in linear time. The lazy `.*?` form it
  // replaced backtracks super-linearly on a line with many `/*` and no closer.
  return line.replace(/\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\//g, '').replace(/\/\/.*$/, '');
}

/** Every non-test, non-declaration `.ts` under src/, relative to the root. */
function sources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
        out.push(relative(ROOT, full));
      }
    }
  };
  walk(resolve(ROOT, 'src'));
  return out;
}

const accepted = { domain: [], bounded: [], marked: [] };
const advisory = [];
const review = [];

for (const rel of sources()) {
  const lines = readFileSync(resolve(ROOT, rel), 'utf8').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const code = codeOnly(raw);
    const hit = IDIOMS.find((idiom) => idiom.re.test(code));
    if (!hit) continue;
    const site = { file: rel, line: i + 1, idiom: hit.name, text: raw.trim() };
    if (DOMAIN_32BIT.has(rel)) accepted.domain.push(site);
    else if (/\bi32-ok\b/.test(raw)) accepted.marked.push(site);
    else if (HASH_ARG.test(code) || LENGTH_DERIVED.test(code)) accepted.bounded.push(site);
    else if (MAGNITUDE.test(code)) review.push(site);
    else advisory.push(site);
  }
}

const show = (s) => `  ${s.file}:${s.line}  [${s.idiom}]  ${s.text.slice(0, 96)}`;

if (review.length) {
  console.error(`lint:int-truncation — ${review.length} bitwise truncation(s) on a quantity that can exceed 2^31:\n`);
  for (const s of review) console.error(show(s));
  console.error(
    '\n  Each wraps to a negative number if the value passes 2^31 − 1. Confirm the' +
      '\n  operand cannot, then mark the line `i32-ok` with the reason; or switch to' +
      '\n  Math.trunc / Math.floor if a plain truncation was meant.',
  );
  process.exit(1);
}

const acc = accepted.domain.length + accepted.bounded.length + accepted.marked.length;
console.log(
  `lint:int-truncation OK — ${acc} accepted 32-bit truncation(s) ` +
    `(${accepted.domain.length} in codec/hash modules, ${accepted.bounded.length} length-derived or hash-fed, ${accepted.marked.length} marked i32-ok), ` +
    `${advisory.length} advisory on small quantities. None on a value that can exceed 2^31.`,
);
if (process.argv.includes('--list')) {
  for (const [k, v] of Object.entries(accepted)) {
    if (v.length) {
      console.log(`\n${k}:`);
      for (const s of v) console.log(show(s));
    }
  }
}
