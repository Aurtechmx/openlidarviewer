/**
 * The committed test-evidence record lists exactly the register's E4 claims.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — plain .mjs helper, no types
import { e4ClaimsFromRegister, scienceRegisterProblems } from '../scripts/lib/evidenceRegisterSync.mjs';

const ROOT = resolve(__dirname, '..');
const register = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
const evidence = JSON.parse(readFileSync(resolve(ROOT, 'docs/validation/test-evidence.json'), 'utf8'));

describe('test-evidence.json science block', () => {
  it('lists the same E4 claims as the claim register', () => {
    expect(scienceRegisterProblems(evidence.science, register)).toEqual([]);
    expect(evidence.science.e4ClaimCount).toBe(e4ClaimsFromRegister(register).length);
  });

  it('reports a record one claim short', () => {
    const ids: string[] = e4ClaimsFromRegister(register);
    const short = { e4ClaimCount: ids.length - 1, e4Claims: ids.slice(0, -1) };
    const p: string[] = scienceRegisterProblems(short, register);
    expect(p.some((s) => s.includes('e4ClaimCount'))).toBe(true);
    expect(p.some((s) => s.includes('omits'))).toBe(true);
  });
});
