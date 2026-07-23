/**
 * evidenceRegistry.test.ts
 *
 * Two jobs: prove the runtime registry cannot drift from the YAML claim register
 * (parse the YAML and compare entry for entry), and prove the export gate
 * refuses to validate anything below its required level.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { EVIDENCE_REGISTRY, exportGate, isValidatedExport } from '../src/validation/evidenceRegistry';

/** Minimal reader for the register's flat, one-field-per-line structure. */
function parseRegister(yaml: string): Record<string, { current: string; required: string; exportAllowed: boolean }> {
  const out: Record<string, { current: string; required: string; exportAllowed: boolean }> = {};
  let id = '';
  let current = '';
  let required = '';
  for (const raw of yaml.split('\n')) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^-?\s*claimId:\s*(\S+)/))) id = m[1];
    else if ((m = line.match(/^currentEvidence:\s*(\S+)/))) current = m[1];
    else if ((m = line.match(/^requiredEvidence:\s*(\S+)/))) required = m[1];
    else if ((m = line.match(/^exportAllowed:\s*(true|false)/))) {
      out[id] = { current, required, exportAllowed: m[1] === 'true' };
    }
  }
  return out;
}

describe('runtime evidence registry vs YAML register', () => {
  const yaml = readFileSync(new URL('../docs/validation/claim-register.yaml', import.meta.url), 'utf8');
  const fromYaml = parseRegister(yaml);

  it('covers exactly the same claim ids as the YAML register', () => {
    expect(Object.keys(EVIDENCE_REGISTRY).sort()).toEqual(Object.keys(fromYaml).sort());
  });

  it('matches the YAML on current / required / exportAllowed for every claim', () => {
    for (const [id, y] of Object.entries(fromYaml)) {
      expect(EVIDENCE_REGISTRY[id], `missing runtime entry: ${id}`).toBeDefined();
      expect(EVIDENCE_REGISTRY[id]).toEqual(y);
    }
  });
});

describe('export gate', () => {
  it('gates a below-required product to exploratory-only', () => {
    const dtm = exportGate('DTM'); // E3 < required E5
    // `allowed` means "exportable as a VALIDATED artifact" — false here, since
    // the product is only offered as an explicitly exploratory export.
    expect(dtm.allowed).toBe(false);
    expect(dtm.exploratoryOnly).toBe(true);
    expect(dtm.reason).toMatch(/exploratory/i);
    expect(isValidatedExport('DTM')).toBe(false);
  });

  it('allows a product that meets its required level as a validated export', () => {
    // REPORT-DIGEST requires only E1 and is at E1.
    expect(isValidatedExport('REPORT-DIGEST')).toBe(true);
  });

  it('refuses an unregistered claim id (treated as E0)', () => {
    const d = exportGate('NOT-A-REAL-CLAIM');
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/unregistered|no evidence-register/i);
  });
});
