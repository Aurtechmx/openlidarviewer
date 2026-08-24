#!/usr/bin/env node
/**
 * lint-oracle-registry.mjs — keeps external-oracle records honest about what
 * they cite and what it is allowed to prove.
 *
 * Three failures this catches, none of which any existing gate can see:
 *
 *   O1  A record names an oracle the registry does not define. An oracle with
 *       no registered lineage, licence or role cannot be reasoned about, and a
 *       typo in an id silently becomes a new oracle.
 *   O2  A record claims a role the registry does not grant that oracle. A
 *       format validator asked to speak to numerical accuracy is the specific
 *       mistake this prevents.
 *   O3  A record counts two oracles of the SAME lineage as independent legs.
 *       Two programs wrapping one library are one implementation. Summing them
 *       reports a corroboration that does not exist.
 *
 * `collectOracleProblems` is a function of the registry and records it is
 * given, so tests/oracleRegistryLint.test.ts constructs both rather than
 * depending on what the repository holds today.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = resolve(ROOT, 'validation/external-oracles/oracle-registry.json');
const ORACLE_DIR = resolve(ROOT, 'validation/external-oracles');

/**
 * Problems in `records` against `registry`.
 *
 * A record is `{ path, oracles: [{ oracleId, role }] }`. Returns
 * `{ problems, cited, lineages }`.
 */
export function collectOracleProblems(registry, records) {
  const problems = [];
  const known = new Map();
  for (const o of registry.oracles ?? []) known.set(o.oracleId, o);

  const roles = new Set(Object.keys(registry.roleDefinitions ?? {}));
  for (const o of registry.oracles ?? []) {
    for (const r of o.roleCapabilities ?? []) {
      if (!roles.has(r)) {
        problems.push(
          `[O0 role-undefined] registry oracle ${o.oracleId} claims role '${r}', which roleDefinitions does not define.`,
        );
      }
    }
  }

  let cited = 0;
  const lineages = new Set();

  for (const record of records) {
    const seenLineage = new Map();
    for (const leg of record.oracles ?? []) {
      cited += 1;
      const oracle = known.get(leg.oracleId);
      if (!oracle) {
        problems.push(
          `[O1 oracle-unregistered] ${record.path} cites '${leg.oracleId}', which is in no registry record. ` +
            'Register it with its lineage, licence and roles, or correct the id.',
        );
        continue;
      }
      lineages.add(oracle.lineageGroup);

      if (leg.role && !(oracle.roleCapabilities ?? []).includes(leg.role)) {
        problems.push(
          `[O2 role-not-granted] ${record.path} uses ${leg.oracleId} as '${leg.role}', which the registry ` +
            `does not grant it. Registered roles: ${(oracle.roleCapabilities ?? []).join(', ') || 'none'}.`,
        );
      }

      const prior = seenLineage.get(oracle.lineageGroup);
      if (prior && prior !== leg.oracleId) {
        problems.push(
          `[O3 lineage-double-counted] ${record.path} counts ${prior} and ${leg.oracleId} as separate legs, but both ` +
            `are lineage '${oracle.lineageGroup}'. They share an implementation family, so one of them is ` +
            'same-lineage corroboration, not a second independent implementation.',
        );
      } else {
        seenLineage.set(oracle.lineageGroup, leg.oracleId);
      }
    }
  }

  return { problems, cited, lineages: lineages.size };
}

/** Every JSON under validation/external-oracles that names oracles. */
function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.json')) yield full;
  }
}

const isCli = resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url));

if (isCli) {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const records = [];

  for (const file of walk(ORACLE_DIR)) {
    if (resolve(file) === REGISTRY) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const legs = parsed.oracles;
    if (!Array.isArray(legs)) continue;
    records.push({
      path: file.slice(ROOT.length + 1),
      oracles: legs.map((l) => ({ oracleId: l.oracleId, role: l.role })),
    });
  }

  const { problems, cited, lineages } = collectOracleProblems(registry, records);

  if (problems.length > 0) {
    console.error(`\nlint:oracle-registry: ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `lint:oracle-registry: OK — ${registry.oracles.length} registered oracle(s), ` +
      `${records.length} record(s) citing ${cited} leg(s) across ${lineages} distinct lineage(s).`,
  );
}
