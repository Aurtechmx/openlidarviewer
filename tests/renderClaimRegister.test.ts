/**
 * renderClaimRegister.test.ts
 *
 * Pins the docs-site claim-register renderer (scripts/render-claim-register.mjs)
 * two ways, mirroring how the runtime registry is guarded:
 *
 *   1. The parse → markdown transform is pure, so a small hand-written YAML
 *      fixture pins the exact table shape — column set, cell escaping, and the
 *      honesty-critical fields (approved vs prohibited claims) — against a
 *      known-good answer.
 *   2. A drift check re-renders the REAL claim register and compares it with
 *      the committed docs-site/validation/claim-register.generated.md, the same
 *      lock-step guard lint-claim-register.mjs applies to the runtime registry:
 *      editing the YAML without re-running `npm run docs:render` fails here,
 *      not on a stale published page.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — plain .mjs script, no type declarations.
import { parseClaimRegister, renderClaimRegisterMarkdown } from '../scripts/render-claim-register.mjs';

const FIXTURE = `
schemaVersion: 1
softwareVersion: 9.9.9
generated: 2099-01-01

claims:
  - claimId: TEST-ONE
    product: Test product | piped
    algorithm: Closed-form thing (variant)
    algorithmVersion: v1.2
    currentEvidence: E2_ANALYTICALLY_VERIFIED
    requiredEvidence: E5_EXTERNALLY_VALIDATED
    exportAllowed: true
    externalValidationStatus: pending
    approvedClaim: "Approved wording."
    prohibitedClaim: ["bad claim A", "bad claim B"]
`;

describe('parseClaimRegister', () => {
  const parsed = parseClaimRegister(FIXTURE);

  it('reads every rendered field of a claim', () => {
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.claims[0]).toEqual({
      id: 'TEST-ONE',
      product: 'Test product | piped',
      algorithm: 'Closed-form thing (variant)',
      algorithmVersion: 'v1.2',
      current: 'E2_ANALYTICALLY_VERIFIED',
      required: 'E5_EXTERNALLY_VALIDATED',
      externalStatus: 'pending',
      approvedClaim: 'Approved wording.',
      prohibitedClaims: ['bad claim A', 'bad claim B'],
    });
  });

  it('carries the register metadata for the page header', () => {
    expect(parsed.softwareVersion).toBe('9.9.9');
    expect(parsed.generated).toBe('2099-01-01');
  });

  it('parses the real register completely (all claims, no missing fields)', () => {
    const yaml = readFileSync(new URL('../docs/validation/claim-register.yaml', import.meta.url), 'utf8');
    const real = parseClaimRegister(yaml);
    // One parsed claim per `claimId:` line — a claim the parser silently drops
    // would be a claim silently missing from the published table.
    expect(real.claims.length).toBe((yaml.match(/claimId:/g) ?? []).length);
    expect(real.claims.length).toBeGreaterThanOrEqual(20);
    for (const c of real.claims) {
      expect(c.product, `claim ${c.id} product`).toBeTruthy();
      expect(c.approvedClaim, `claim ${c.id} approvedClaim`).toBeTruthy();
      expect(c.prohibitedClaims.length, `claim ${c.id} prohibitedClaims`).toBeGreaterThan(0);
    }
  });
});

describe('renderClaimRegisterMarkdown', () => {
  const md = renderClaimRegisterMarkdown(parseClaimRegister(FIXTURE));

  it('emits the agreed column set, in order', () => {
    expect(md).toContain(
      '| Claim | Product | Method@version | Current evidence | Required | External status | Approved claim | Prohibited claims |',
    );
  });

  it('escapes pipes inside a cell so the table cannot break', () => {
    expect(md).toContain('Test product \\| piped');
  });

  it('renders method@version, both evidence levels, and both claim wordings', () => {
    const row = md.split('\n').find((l: string) => l.includes('TEST-ONE'));
    expect(row).toBeDefined();
    expect(row).toContain('Closed-form thing (variant) @ v1.2');
    expect(row).toContain('E2_ANALYTICALLY_VERIFIED');
    expect(row).toContain('E5_EXTERNALLY_VALIDATED');
    expect(row).toContain('pending');
    expect(row).toContain('Approved wording.');
    expect(row).toContain('bad claim A; bad claim B');
  });

  it('stamps the register version and an AUTO-GENERATED marker', () => {
    expect(md).toContain('AUTO-GENERATED');
    expect(md).toContain('9.9.9');
  });
});

describe('generated docs page vs the real register (drift check)', () => {
  it('docs-site/validation/claim-register.generated.md is fresh', () => {
    const yaml = readFileSync(new URL('../docs/validation/claim-register.yaml', import.meta.url), 'utf8');
    const committed = readFileSync(
      new URL('../docs-site/validation/claim-register.generated.md', import.meta.url),
      'utf8',
    );
    expect(committed).toBe(renderClaimRegisterMarkdown(parseClaimRegister(yaml)));
  });
});
