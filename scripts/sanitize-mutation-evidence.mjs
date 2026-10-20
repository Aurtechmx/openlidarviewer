#!/usr/bin/env node
/**
 * sanitize-mutation-evidence.mjs — rebuild a mutation evidence file from its
 * known fields before the mutation workflow commits it.
 *
 * The workflow's PR job commits a JSON file produced by a job that ran the
 * repository's code. It is data: every field is copied only when it has the
 * expected type and shape, and any other field is dropped.
 *
 * Usage: node scripts/sanitize-mutation-evidence.mjs <in.json> <out.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const MUTANT_KEYS = ['killed', 'timeout', 'survived', 'noCoverage', 'ignored', 'errors', 'detected', 'undetected', 'scored'];

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (v) => Number.isInteger(v) && v >= 0;
const text = (v, re) => typeof v === 'string' && v.length <= 200 && re.test(v);

/** The evidence rebuilt from known fields; throws when a required one is missing or malformed. */
export function sanitizeMutationEvidence(e) {
  if (typeof e !== 'object' || e === null || Array.isArray(e)) throw new Error('evidence is not an object');
  if (!finite(e.score) || e.score < 0 || e.score > 100) throw new Error('score is not a number from 0 to 100');
  const out = { schemaVersion: 1, project: 'openlidarviewer', score: e.score };
  if (finite(e.break)) out.break = e.break;
  if (typeof e.mutants === 'object' && e.mutants !== null) {
    const m = {};
    for (const k of MUTANT_KEYS) if (count(e.mutants[k])) m[k] = e.mutants[k];
    out.mutants = m;
  }
  if (Array.isArray(e.mutate)) out.mutate = e.mutate.filter((p) => text(p, /^src\/[\w./-]+\.ts$/) && !p.includes('..'));
  if (text(e.commit, /^[0-9a-f]{40}$/)) out.commit = e.commit;
  if (text(e.measuredAt, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/)) out.measuredAt = e.measuredAt;
  if (typeof e.ranInThisGate === 'boolean') out.ranInThisGate = e.ranInThisGate;
  if (text(e.workflow, /^[\w -]+$/)) out.workflow = e.workflow;
  if (text(e.workflowRunId, /^\d+$/)) out.workflowRunId = e.workflowRunId;
  if (text(e.workflowRunUrl, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/)) out.workflowRunUrl = e.workflowRunUrl;
  if (text(e.nodeVersion, /^v\d+\.\d+\.\d+$/)) out.nodeVersion = e.nodeVersion;
  if (text(e.platform, /^[\w-]+$/)) out.platform = e.platform;
  return out;
}

if (isCliEntry(import.meta.url)) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('usage: sanitize-mutation-evidence.mjs <in.json> <out.json>');
    process.exit(2);
  }
  try {
    const clean = sanitizeMutationEvidence(JSON.parse(readFileSync(input, 'utf8')));
    writeFileSync(output, `${JSON.stringify(clean, null, 2)}\n`);
  } catch (err) {
    console.error(`mutation evidence refused: ${err.message}`);
    process.exit(1);
  }
}
