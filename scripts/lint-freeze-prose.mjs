#!/usr/bin/env node
/**
 * lint-freeze-prose.mjs
 *
 * Keep the prose that describes a tolerance's freeze in step with the protocol
 * record that carries it. `validation/protocols/*.protocol.json` records, per
 * claim, whether a tolerance was `preregistered` (on record before the result
 * existed) or `adopted-with-result` (fixed in the same change as the result).
 * The claim register's `approvedClaim` strings and the terrain validation
 * matrix restate that status in words, and four register entries said
 * "preregistered" for claims whose protocol says `adopted-with-result`.
 * Nothing compared the two.
 *
 * Rules:
 *   F1  a claim's register prose asserts "preregistered" while no protocol
 *       governing that claim records freeze.status "preregistered";
 *   F2  a claim's register prose asserts "adopted with the result" while no
 *       protocol governing that claim records "adopted-with-result";
 *   F3  the same two tests for a row of docs/validation/terrain-validation-matrix.md,
 *       where the row's claims are the register entries whose supportingTests
 *       name a test file the row cites.
 *
 * A negated use ("not preregistered", "rather than preregistered", "carried
 * over rather than preregistered") asserts the opposite and is not a positive
 * use. A claim with no protocol has nothing to compare against and is skipped.
 * Example protocols (`example: true`) are not records.
 *
 * Exit 0 = clean; exit 1 = a contradiction (prints each).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REGISTER = 'docs/validation/claim-register.yaml';
export const PROTOCOLS = 'validation/protocols';
export const MATRIX = 'docs/validation/terrain-validation-matrix.md';

/** The two freeze statuses a protocol may record. */
export const FREEZE_STATUSES = ['preregistered', 'adopted-with-result'];

/**
 * Words that, within a few tokens before a status word, turn the mention into
 * its denial. "than" covers "rather than preregistered" and "other than".
 */
const NEGATION = /\b(not|never|no|than|without|instead of|nor)\b[^.;]{0,24}$/i;

/**
 * Positive assertions of each status in `text`. A mention is positive when no
 * negation sits in the 40 characters before it. The adopted status is written
 * either as the field value or as prose ("adopted with the result", "adopted
 * with its result"); both count.
 */
export function assertedStatuses(text) {
  const out = new Set();
  const forms = [
    ['preregistered', /\bpreregistered\b/gi],
    ['adopted-with-result', /\badopted[- ]with[- ](?:the[- ]|its[- ])?results?\b/gi],
  ];
  for (const [status, re] of forms) {
    for (const m of String(text).matchAll(re)) {
      const before = String(text).slice(Math.max(0, m.index - 40), m.index);
      if (NEGATION.test(before)) continue;
      out.add(status);
    }
  }
  return out;
}

/** claimId -> Set of freeze statuses, from parsed protocol records. */
export function freezeStatusesByClaim(protocols) {
  const out = new Map();
  for (const p of protocols) {
    if (!p || p.example === true || !Array.isArray(p.claims)) continue;
    for (const c of p.claims) {
      const status = c?.freeze?.status;
      if (!c?.claimId || !FREEZE_STATUSES.includes(status)) continue;
      if (!out.has(c.claimId)) out.set(c.claimId, new Set());
      out.get(c.claimId).add(status);
    }
  }
  return out;
}

/**
 * The register split into claim blocks: `{ id, line, text, supportingTests }`.
 * A block runs from its `claimId:` line to the next one. `supportingTests` is
 * the inline list on that field, as written (globs included).
 */
export function registerBlocks(yamlText) {
  const lines = yamlText.split('\n');
  const blocks = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*-\s*claimId:\s*(\S+)/.exec(lines[i]);
    if (m) {
      cur = { id: m[1], line: i + 1, lines: [], supportingTests: [] };
      blocks.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.lines.push(lines[i]);
    const t = /^\s*supportingTests:\s*\[(.*)\]\s*$/.exec(lines[i]);
    if (t) cur.supportingTests = t[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return blocks.map((b) => ({ id: b.id, line: b.line, text: b.lines.join('\n'), supportingTests: b.supportingTests }));
}

/** Whether a supportingTests entry (possibly a glob) names `file`. */
export function testEntryMatches(entry, file) {
  if (!entry.includes('*')) return entry === file;
  const re = new RegExp(`^${entry.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(file);
}

/** Problems for one text against the statuses its claims' protocols carry. */
function contradictions(where, text, claimIds, byClaim) {
  const problems = [];
  const governed = claimIds.filter((id) => byClaim.has(id));
  if (governed.length === 0) return problems;
  const carried = new Set();
  for (const id of governed) for (const s of byClaim.get(id)) carried.add(s);
  for (const status of assertedStatuses(text)) {
    if (carried.has(status)) continue;
    const says = status === 'preregistered' ? 'a preregistered tolerance' : 'a tolerance adopted with its result';
    problems.push(
      `${where} describes ${says}, but the protocol freeze for ${governed.join(', ')} records `
        + `${[...carried].join(', ')}. Say what the protocol carries, or change the protocol record and its witness.`,
    );
  }
  return problems;
}

/** F1 and F2 over the register blocks. */
export function registerProblems(yamlText, byClaim) {
  const problems = [];
  for (const b of registerBlocks(yamlText)) {
    problems.push(...contradictions(`${REGISTER}:${b.line} (${b.id})`, b.text, [b.id], byClaim));
  }
  return problems;
}

/** F3 over the matrix rows. A row's claims are those whose supportingTests name a test the row cites. */
export function matrixProblems(markdown, yamlText, byClaim) {
  const problems = [];
  const blocks = registerBlocks(yamlText);
  const lines = markdown.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) continue;
    const files = [...line.matchAll(/`(tests\/[^`]+\.test\.ts)`/g)].map((m) => m[1]);
    if (files.length === 0) continue;
    const claimIds = blocks
      .filter((b) => b.supportingTests.some((e) => files.some((f) => testEntryMatches(e, f))))
      .map((b) => b.id);
    problems.push(...contradictions(`${MATRIX}:${i + 1}`, line, claimIds, byClaim));
  }
  return problems;
}

/** Every non-example protocol record on disk. */
function loadProtocols(dir = resolve(ROOT, PROTOCOLS)) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.protocol.json'))
    .map((n) => {
      try {
        return JSON.parse(readFileSync(join(dir, n), 'utf8'));
      } catch {
        return null;
      }
    });
}

export function lintFreezeProse({ yamlText, markdown, protocols } = {}) {
  const byClaim = freezeStatusesByClaim(protocols ?? loadProtocols());
  const yaml = yamlText ?? readFileSync(resolve(ROOT, REGISTER), 'utf8');
  const md = markdown ?? readFileSync(resolve(ROOT, MATRIX), 'utf8');
  return {
    problems: [...registerProblems(yaml, byClaim), ...matrixProblems(md, yaml, byClaim)],
    governed: byClaim.size,
  };
}

if (isCliEntry(import.meta.url)) {
  const { problems, governed } = lintFreezeProse();
  if (governed === 0) {
    console.error('lint:freeze-prose FAILED — no protocol records found; nothing to compare the prose against.');
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error('lint:freeze-prose FAILED — prose names a freeze status its protocol does not carry:\n');
    for (const p of problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  console.log(`lint:freeze-prose OK — register prose and the terrain matrix agree with the freeze status of ${governed} protocol-governed claim(s).`);
}
