/**
 * evidenceRegisterSync.mjs — the E4 claims a test-evidence record lists must be
 * the E4 claims the claim register holds.
 *
 * collect-evidence.mjs derives `science.e4Claims` from the register, but only
 * when a release run regenerates the record. A claim promoted between runs left
 * the committed record one short, and nothing compared the two.
 */

/** The claim ids at E4 in a claim-register text, in register order. */
export function e4ClaimsFromRegister(registerText) {
  return [...registerText.matchAll(/claimId:\s*([A-Z0-9-]+)[\s\S]*?currentEvidence:\s*(E\d)_/g)]
    .filter((m) => m[2] === 'E4')
    .map((m) => m[1]);
}

/** Problems (strings) where `science` disagrees with the register; empty when in sync. */
export function scienceRegisterProblems(science, registerText) {
  const expected = e4ClaimsFromRegister(registerText);
  const listed = Array.isArray(science?.e4Claims) ? science.e4Claims : [];
  const problems = [];
  if (science?.e4ClaimCount !== expected.length) {
    problems.push(`science.e4ClaimCount is ${science?.e4ClaimCount} but the claim register holds ${expected.length} E4 claims.`);
  }
  const missing = expected.filter((id) => !listed.includes(id));
  const extra = listed.filter((id) => !expected.includes(id));
  if (missing.length > 0) problems.push(`science.e4Claims omits ${missing.join(', ')}, which the register holds at E4.`);
  if (extra.length > 0) problems.push(`science.e4Claims lists ${extra.join(', ')}, which the register does not hold at E4.`);
  return problems;
}
