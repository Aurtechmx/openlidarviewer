/**
 * changeRawNetEvidenceIsolation.test.ts — the raw (unthresholded) net change
 * volume must not inherit the E4 the THRESHOLDED gross gain/loss earned.
 *
 * The GRASS r.univar cross-implementation validated the thresholded gross gain
 * and loss (method olv.change.dtm-difference). The raw net over every comparable
 * cell (method olv.change.dtm-difference.raw-net) is checked against the
 * closed-form analytical oracle only. This pins that isolation in two places:
 *   - the method→test binding, where the raw-net method must NOT list the GRASS
 *     agreement test that backs the thresholded E4; and
 *   - the claim register, whose CHANGE-VOLUME entry must name both quantities
 *     separately and state that the raw net is not cross-implementation validated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMethodId } from '../src/science/methodRegistry';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
const binding = readFileSync(resolve(ROOT, 'tests/methodSupportingTests.test.ts'), 'utf8');

/** Escape every regex metacharacter in a literal, so an id is matched verbatim. */
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Extract a method's supporting-test list literal from the binding source. */
function supportingTests(id: string): string {
  const re = new RegExp(`'${escapeRegExp(id)}':\\s*(\\[[^\\]]*\\])`);
  const m = binding.match(re);
  expect(m, `no supporting-test binding for ${id}`).toBeTruthy();
  return m![1];
}

describe('raw-net vs thresholded change-volume evidence isolation', () => {
  it('both methods are registered and distinct', () => {
    expect(isMethodId('olv.change.dtm-difference')).toBe(true);
    expect(isMethodId('olv.change.dtm-difference.raw-net')).toBe(true);
  });

  it('the thresholded method carries the GRASS cross-implementation test', () => {
    expect(supportingTests('olv.change.dtm-difference')).toMatch(/changeGrassAgreement\.test\.ts/);
  });

  it('the raw-net method does NOT carry the GRASS cross-implementation test', () => {
    const rawNet = supportingTests('olv.change.dtm-difference.raw-net');
    expect(rawNet).not.toMatch(/changeGrassAgreement/);
    // It rests on the analytical oracle instead.
    expect(rawNet).toMatch(/changeVolumeAnalyticalOracle\.test\.ts/);
  });

  it('the CHANGE-VOLUME claim names both quantities and isolates the raw-net evidence', () => {
    const block = yaml.slice(yaml.indexOf('claimId: CHANGE-VOLUME'));
    const claim = block.slice(0, block.indexOf('\n  - claimId:'));
    // Both quantities are explicit and separately named.
    expect(claim).toMatch(/thresholded/i);
    expect(claim).toMatch(/raw net/i);
    // The raw net is stated as NOT carrying the thresholded E4.
    expect(claim).toMatch(/not cross-implementation validated/i);
    expect(claim).toMatch(/analytical/i);
  });
});
