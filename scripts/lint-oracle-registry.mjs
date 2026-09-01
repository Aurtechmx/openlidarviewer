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
 * The O rules trust the registry to be well formed. `collectRegistryProblems`
 * checks that assumption, because a broken entry defeats them silently:
 *
 *   R0  Two entries share an oracleId. The later one overwrites the earlier in
 *       every lookup, so the first oracle's roles and lineage vanish.
 *   R1  An entry omits oracleId, name, version, lineageGroup or license. A
 *       dropped lineageGroup is the one O3 reads to see a double count.
 *   R2  roleCapabilities is empty or absent, so the entry can play no role a
 *       record may claim.
 *   R3  domains is empty or absent.
 *
 * Both collectors are functions of their input, so tests/oracleRegistryLint.
 * test.ts constructs synthetic registries and records rather than depending on
 * what the repository holds today.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

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

/**
 * Problems in the registry's own entries. Returns `{ problems }`.
 *
 * Rules R0-R3 above. Missing scalar fields are reported one per field so the
 * message names which one; a missing oracleId is labelled by list position,
 * since there is no id to name it by.
 */
export function collectRegistryProblems(registry) {
  const problems = [];
  const seen = new Set();
  const oracles = registry.oracles ?? [];

  oracles.forEach((o, i) => {
    const hasId = typeof o.oracleId === 'string' && o.oracleId.trim() !== '';
    const label = hasId ? o.oracleId : `entry #${i}`;

    if (hasId) {
      if (seen.has(o.oracleId)) {
        problems.push(
          `[R0 duplicate-oracle-id] registry defines ${o.oracleId} more than once. ` +
            "The later entry overwrites the earlier in every lookup, so the first oracle's roles and lineage vanish.",
        );
      } else {
        seen.add(o.oracleId);
      }
    }

    for (const field of ['oracleId', 'name', 'version', 'lineageGroup', 'license']) {
      const v = o[field];
      if (typeof v !== 'string' || v.trim() === '') {
        problems.push(
          `[R1 field-missing] registry ${label} has no ${field}. ` +
            'Every registered oracle needs one before a study can cite it.',
        );
      }
    }

    if (!Array.isArray(o.roleCapabilities) || o.roleCapabilities.length === 0) {
      problems.push(
        `[R2 role-capabilities-empty] registry ${label} lists no roleCapabilities, ` +
          'so it can play no role a record may claim.',
      );
    }

    if (!Array.isArray(o.domains) || o.domains.length === 0) {
      problems.push(`[R3 domains-empty] registry ${label} lists no domains.`);
    }
  });

  return { problems };
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

const isCli = isCliEntry(import.meta.url);

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
  const allProblems = [...collectRegistryProblems(registry).problems, ...problems];

  if (allProblems.length > 0) {
    console.error(`\nlint:oracle-registry: ${allProblems.length} problem(s):\n`);
    for (const p of allProblems) console.error(`  - ${p}`);
    console.error('');
    process.exit(1);
  }

  console.log(
    `lint:oracle-registry: OK — ${registry.oracles.length} registered oracle(s), ` +
      `${records.length} record(s) citing ${cited} leg(s) across ${lineages} distinct lineage(s).`,
  );
}
