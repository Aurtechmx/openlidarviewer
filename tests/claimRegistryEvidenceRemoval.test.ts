/**
 * claimRegistryEvidenceRemoval.test.ts — evidence removal can only DOWNGRADE a
 * claim, never strand it authorized above the evidence that remains.
 *
 * The registry pins each claim's CURRENT evidence level, its REQUIRED level and
 * whether a validated export is allowed. This file treats "removing a supporting
 * study / independent check" as what it actually is at the level the registry
 * encodes: a reduction of `current`. The invariant is monotone — a lower
 * `current` may only weaken the verdict, and restoring it must recover the
 * verdict exactly (no hysteresis, no ratchet).
 *
 * It also pins the synchronisation boundary: the generated runtime registry must
 * remain a faithful projection of the YAML source, so a stale generated artifact
 * cannot silently authorise a claim the source no longer supports.
 *
 * All transforms are pure and local to the test; no production module is asked
 * to carry a new field, and no generated artifact is patched.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EVIDENCE_REGISTRY } from '../src/validation/claimRegistry.generated';
import {
  EVIDENCE_LEVELS,
  evidenceRank,
  meetsRequired,
  isSelfVerified,
  INDEPENDENCE_FLOOR,
  type EvidenceLevel,
} from '../src/validation/evidenceLevel';

/** One rung weaker on the evidence ladder (clamped at the floor). */
function weaken(level: EvidenceLevel): EvidenceLevel {
  const i = EVIDENCE_LEVELS.indexOf(level);
  return EVIDENCE_LEVELS[Math.max(0, i - 1)];
}
/** "Validated" == the current evidence meets the required bar — the gate's own rule. */
const validated = (current: EvidenceLevel, required: EvidenceLevel) => meetsRequired(current, required);

const entries = Object.entries(EVIDENCE_REGISTRY);
/** Claims whose strongest (validated) claim is currently live: current meets required. */
const liveClaims = entries.filter(([, e]) => validated(e.current, e.required));

describe('removing supporting evidence downgrades the claim', () => {
  it('the fixture has live claims to remove support from (not vacuous)', () => {
    expect(liveClaims.length).toBeGreaterThan(0);
  });

  it('a claim held at its required bar is withdrawn when support is removed (current drops one rung)', () => {
    // "Support completeness lost → strongest claim withdrawn." A claim sitting
    // exactly at its bar has no headroom: removing one rung of evidence must drop
    // it below required.
    const atBar = entries.filter(([, e]) => evidenceRank(e.current) === evidenceRank(e.required));
    expect(atBar.length).toBeGreaterThan(0);
    for (const [id, e] of atBar) {
      const removed = weaken(e.current);
      if (removed === e.current) continue; // already at the ladder floor — nothing to remove
      expect(validated(removed, e.required), `${id}: withdrawing support must un-validate`).toBe(false);
    }
  });

  it('no removal ever UPGRADES a verdict — monotonicity holds for every claim', () => {
    for (const [id, e] of entries) {
      const removed = weaken(e.current);
      expect(evidenceRank(removed), `${id}: a removal cannot raise the level`).toBeLessThanOrEqual(evidenceRank(e.current));
      // If it was not validated before, it cannot become validated by removal.
      if (!validated(e.current, e.required)) {
        expect(validated(removed, e.required)).toBe(false);
      }
    }
  });
});

describe('removing INDEPENDENT evidence downgrades an independence-dependent claim', () => {
  it('a claim requiring cross-implementation independence loses validation when dropped below the floor', () => {
    // Claims whose REQUIRED level is at/above the independence floor depend on
    // evidence that is not self-verified. Removing that independence (current →
    // below the floor) must both flip isSelfVerified and un-validate the claim.
    const independenceDependent = liveClaims.filter(([, e]) => evidenceRank(e.required) >= evidenceRank(INDEPENDENCE_FLOOR));
    expect(independenceDependent.length).toBeGreaterThan(0);
    for (const [id, e] of independenceDependent) {
      const belowFloor = weaken(INDEPENDENCE_FLOOR);
      expect(isSelfVerified(belowFloor), `${id}: below the floor is self-verified`).toBe(true);
      expect(validated(belowFloor, e.required), `${id}: self-verified evidence cannot back an independent claim`).toBe(false);
    }
  });
});

describe('narrowing the validated scope narrows the claim', () => {
  it('raising the required bar (a narrower validated scope) can only withdraw, never grant', () => {
    // "Validation scope narrowed → claim scope narrows." Modelled as a stricter
    // required level: a claim validated at the old bar must not gain validation,
    // and one held exactly at the bar is withdrawn.
    for (const [id, e] of entries) {
      const narrower = Math.min(EVIDENCE_LEVELS.length - 1, evidenceRank(e.required) + 1);
      const stricter = EVIDENCE_LEVELS[narrower];
      const before = validated(e.current, e.required);
      const after = validated(e.current, stricter);
      // A narrower scope cannot turn a refused claim into a validated one.
      if (!before) expect(after, `${id}`).toBe(false);
      // No claim's validation strengthens under a stricter bar.
      expect(Number(after)).toBeLessThanOrEqual(Number(before));
    }
  });
});

describe('restoring support recovers the verdict exactly (no ratchet)', () => {
  it('re-adding the removed rung returns each live claim to validated', () => {
    for (const [id, e] of liveClaims) {
      const removed = weaken(e.current);
      const restored = e.current; // put the rung back
      expect(evidenceRank(restored), `${id}: restore is the inverse of remove`).toBeGreaterThanOrEqual(evidenceRank(removed));
      expect(validated(restored, e.required), `${id}: restored support re-validates`).toBe(true);
    }
  });
});

describe('the generated registry stays synced with the YAML source', () => {
  // A stale generated artifact could authorise a claim the source has downgraded.
  const yaml = readFileSync(new URL('../docs/validation/claim-register.yaml', import.meta.url), 'utf8');

  /** Minimal reader for the register's flat, one-field-per-line structure. */
  function parseRegister(src: string): Record<string, { current: string; required: string; exportAllowed: boolean }> {
    const out: Record<string, { current: string; required: string; exportAllowed: boolean }> = {};
    let id = '', current = '', required = '';
    for (const raw of src.split('\n')) {
      const line = raw.trim();
      let m: RegExpMatchArray | null;
      if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) id = m[1];
      else if ((m = line.match(/^currentEvidence:\s*(\S+)/))) current = m[1];
      else if ((m = line.match(/^requiredEvidence:\s*(\S+)/))) required = m[1];
      else if ((m = line.match(/^exportAllowed:\s*(true|false)/))) out[id] = { current, required, exportAllowed: m[1] === 'true' };
    }
    return out;
  }

  const fromYaml = parseRegister(yaml);

  it('covers exactly the same claim ids as the source', () => {
    expect(Object.keys(EVIDENCE_REGISTRY).sort()).toEqual(Object.keys(fromYaml).sort());
  });

  it('matches the source on current / required / exportAllowed for every claim', () => {
    for (const [id, y] of Object.entries(fromYaml)) {
      expect(EVIDENCE_REGISTRY[id], `missing runtime entry: ${id}`).toEqual(y);
    }
  });
});
