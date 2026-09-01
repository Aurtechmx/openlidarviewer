/**
 * capabilityTruth.test.ts — a shipping claim's method may only cite code the
 * running application reaches.
 *
 * The provenance chain claim → method → implementation source is only honest if
 * that source is code the product actually runs. docs/validation/unreachable-modules.json
 * is the register of every module under src/ the application does not reach
 * (staged, validation-only, reference-only or orphan). A claim whose
 * softwareStatus is `shipping` asserts the product does the thing; if its
 * method's implementation names an unreachable module, the record points a live
 * claim at code no live path executes.
 *
 * This binds the two registers: for every shipping claim with a methodId, none
 * of that method's implementation paths may appear in the unreachable register.
 * The YAML is read the same line-based way as scripts/lint-claim-register.mjs
 * (no YAML parser is a declared dependency).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METHOD_REGISTRY } from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Shipping claims paired with their methodId, from the register. */
function shippingClaimMethods(): { claimId: string; methodId: string }[] {
  const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
  const out: { claimId: string; methodId: string; softwareStatus: string | null }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (const raw of yaml.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) {
      cur = { claimId: m[1], methodId: '', softwareStatus: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((m = line.match(/^methodId:\s*(\S+)/))) cur.methodId = m[1];
    else if ((m = line.match(/^softwareStatus:\s*(\S+)/))) cur.softwareStatus = m[1];
  }
  return out
    .filter((c) => c.softwareStatus === 'shipping' && c.methodId)
    .map(({ claimId, methodId }) => ({ claimId, methodId }));
}

/** Every module path the running application does not reach. */
function unreachablePaths(): Set<string> {
  const doc = JSON.parse(
    readFileSync(resolve(ROOT, 'docs/validation/unreachable-modules.json'), 'utf8'),
  ) as { modules: { path: string }[] };
  return new Set(doc.modules.map((m) => m.path));
}

describe('capability truth: shipping claims cite reachable code', () => {
  it('pairs a meaningful number of shipping claims to methods', () => {
    expect(shippingClaimMethods().length).toBeGreaterThanOrEqual(10);
  });

  it('no shipping claim method names an unreachable implementation module', () => {
    const unreachable = unreachablePaths();
    const offenders: string[] = [];
    for (const { claimId, methodId } of shippingClaimMethods()) {
      const entry = METHOD_REGISTRY[methodId];
      expect(entry, `claim ${claimId} names unregistered method ${methodId}`).toBeDefined();
      for (const p of entry.implementation) {
        if (unreachable.has(p)) offenders.push(`${claimId} → ${methodId} → ${p}`);
      }
    }
    expect(
      offenders,
      `shipping claims citing unreachable code:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
