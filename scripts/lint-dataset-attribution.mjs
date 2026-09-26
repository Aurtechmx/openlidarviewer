#!/usr/bin/env node
/**
 * lint-dataset-attribution.mjs: a dataset whose licence requires attribution
 * is credited wherever the repository carries something derived from it.
 *
 * For every record in validation/datasets/dataset-register.yaml whose
 * `redistribution` is `attribution-required` or `share-alike`, any tracked
 * file whose name carries the record's ordinal (`OLV-DS-NNN`) counts as a
 * committed derivative. Such a dataset must be named, by that ordinal, in both
 * docs/project/THIRD_PARTY_NOTICES.md and public/credits.html.
 *
 * Only file NAMES are matched: a derivative whose name does not carry the id
 * is not seen, so name derived files after the dataset they come from.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ATTRIBUTION = new Set(['attribution-required', 'share-alike']);

/** [{ ordinal, redistribution }] for each register record. */
export function registerRecords(yaml) {
  return yaml
    .split(/\n\s*- datasetId: /)
    .slice(1)
    .map((chunk) => {
      const id = chunk.split('\n')[0].trim();
      const ordinal = id.match(/^OLV-DS-\d{3}/)?.[0] ?? null;
      const redistribution = chunk.match(/\n\s*redistribution:\s*(\S+)/)?.[1] ?? null;
      return { id, ordinal, redistribution };
    })
    .filter((r) => r.ordinal);
}

export function collectAttributionProblems({ yaml, files, notices, credits }) {
  const problems = [];
  for (const r of registerRecords(yaml)) {
    if (!ATTRIBUTION.has(r.redistribution)) continue;
    const pattern = new RegExp(`${r.ordinal}(?!\\d)`);
    const derived = files.filter((f) => !f.endsWith('dataset-register.yaml') && pattern.test(f.split('/').pop()));
    if (!derived.length) continue;
    for (const [name, text] of [['docs/project/THIRD_PARTY_NOTICES.md', notices], ['public/credits.html', credits]]) {
      if (!pattern.test(text)) {
        problems.push(`${r.id} (${r.redistribution}) has committed derived files (${derived[0]}) but is not credited in ${name}.`);
      }
    }
  }
  return problems;
}

/** Tracked files, or, in an extracted source archive with no git, a filesystem walk. */
function listFiles(root) {
  try {
    return execFileSync('git', ['ls-files'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').filter(Boolean);
  } catch {
    const out = [];
    const skip = new Set(['.git', 'node_modules', 'dist', 'release', 'test-results', 'playwright-report']);
    const walk = (rel) => {
      for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else if (e.isFile()) out.push(r);
      }
    };
    walk('');
    return out;
  }
}

if (isCliEntry(import.meta.url)) {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');
  const files = listFiles(ROOT);
  const problems = collectAttributionProblems({
    yaml: read('validation/datasets/dataset-register.yaml'),
    files,
    notices: read('docs/project/THIRD_PARTY_NOTICES.md'),
    credits: read('public/credits.html'),
  });
  if (problems.length) {
    for (const p of problems) console.error(`lint:dataset-attribution: ${p}`);
    process.exit(1);
  }
  console.log('lint:dataset-attribution OK: every attribution-required dataset with committed derived files is credited.');
}
