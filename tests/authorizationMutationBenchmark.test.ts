/**
 * authorizationMutationBenchmark.test.ts — the frozen A01–A28 adversarial
 * benchmark for scientific-output authorization. Asserts the integrity
 * targets on the real authorization machinery: UOAR = 0, ORR = 0, ATR = 1,
 * SAAR = 0, CPAR = 0.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scoreAuthorizationBenchmark, AUTHORIZATION_CASES } from '../src/validation/authorizationBenchmark';

/**
 * Regenerate the committed artifacts with:
 *   GEN_AUTH_ARTIFACTS=1 npx vitest run tests/authorizationMutationBenchmark.test.ts
 * Off by default — a normal test run never writes.
 */
function writeArtifactsIfRequested(): void {
  if (!process.env.GEN_AUTH_ARTIFACTS) return;
  const score = scoreAuthorizationBenchmark();
  const dir = resolve(__dirname, '../validation/authorization');
  mkdirSync(dir, { recursive: true });
  const cases = AUTHORIZATION_CASES.map((c) => ({ id: c.id, title: c.title, kind: c.kind, product: c.product }));
  const benchmarkVersion = 4; // v1 = A01–A12; v2 adds A13–A16 + A20 (freshness/completeness) + SAAR; v3 adds A17–A19 (scope non-broadening); v4 adds A21–A28 (production permit) + CPAR.
  writeFileSync(resolve(dir, 'cases.json'), JSON.stringify({
    benchmarkVersion,
    description: 'Frozen scientific-output authorization adversarial benchmark (A01–A28).',
    caseCount: cases.length,
    controlCount: cases.filter((c) => c.kind === 'control').length,
    unsupportedCount: cases.filter((c) => c.kind === 'adversarial').length,
    cases,
  }, null, 2) + '\n');
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({
    benchmarkVersion,
    source: 'src/validation/authorizationBenchmark.ts',
    metrics: { UOAR: score.uoar, ORR: score.orr, ATR: score.atr, SAAR: score.saar, CPAR: score.cpar },
    totals: score.totals,
    results: score.results,
  }, null, 2) + '\n');
  const line = (r: typeof score.results[number]): string =>
    `| ${r.id} | ${r.kind} | ${r.product} | ${r.authorized ? 'authorized' : 'refused'} | ${r.correct ? '✓' : '✗'} | ${r.title} |`;
  writeFileSync(resolve(dir, 'summary.md'),
    `# Authorization integrity benchmark\n\n` +
    `Frozen adversarial cases for scientific-output authorization. Each perturbs a fully-supported baseline and asks whether the authorization machinery refuses an unsupported output. A01–A12 construct a state (\`ProcessService.authorize\` / \`runIfAuthorized\` / \`isAuthenticAuthorization\`), A13–A20 reuse a token across states, A21–A28 mint the production export permit (\`resolveContourExportPermit\`). ATR is a structural invariant: a token carries its grant reason and a permit carries its claim set by construction.\n\n` +
    `| Metric | Value | Target |\n|---|---|---|\n` +
    `| UOAR (unsupported authorized) | ${score.uoar} | 0 |\n` +
    `| ORR (valid controls refused) | ${score.orr} | 0 |\n` +
    `| ATR (authorized w/ provenance) | ${score.atr} | 1 |\n` +
    `| SAAR (stale tokens accepted) | ${score.saar} | 0 |\n` +
    `| CPAR (coverage-blind production permits) | ${score.cpar} | 0 |\n\n` +
    `| Case | Kind | Product | Outcome | Correct | What it perturbs |\n|---|---|---|---|---|---|\n` +
    score.results.map(line).join('\n') + '\n');
}

describe('authorization mutation benchmark (A01–A28)', () => {
  const score = scoreAuthorizationBenchmark();

  it('every case reaches the correct authorization outcome', () => {
    const wrong = score.results.filter((r) => !r.correct);
    expect(
      wrong,
      `cases with an incorrect outcome:\n${wrong.map((r) => `${r.id} ${r.title} → authorized=${r.authorized}`).join('\n')}`,
    ).toHaveLength(0);
  });

  it('UOAR = 0 — no unsupported/adversarial output is authorized', () => {
    expect(score.uoar).toBe(0);
  });

  it('ATR = 1 — every authorized output has resolvable provenance', () => {
    expect(score.atr).toBe(1);
  });

  it('ORR = 0 — no valid supported control is refused (no over-refusal)', () => {
    expect(score.orr).toBe(0);
  });

  it('SAAR = 0 — no reused-across-state (stale) token is accepted', () => {
    expect(score.saar).toBe(0);
  });

  it('CPAR = 0 — no production permit on non-full coverage resolves validated', () => {
    expect(AUTHORIZATION_CASES.filter((c) => c.coverageBlindCase).map((c) => c.id)).toEqual(['A21', 'A22', 'A24']);
    expect(score.cpar).toBe(0);
  });

  it('A28 is the only production-permit case that resolves validated', () => {
    const production = score.results.filter((r) => Number(r.id.slice(1)) >= 21);
    expect(production.map((r) => r.id)).toEqual(['A21', 'A22', 'A23', 'A24', 'A25', 'A26', 'A27', 'A28']);
    expect(production.filter((r) => r.authorized).map((r) => r.id)).toEqual(['A27', 'A28']);
  });

  it('preserves A01–A20 and appends A21–A28 (production permit)', () => {
    const ids = AUTHORIZATION_CASES.map((c) => c.id);
    expect(ids).toEqual(Array.from({ length: 28 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`));
    expect(AUTHORIZATION_CASES.filter((c) => c.kind === 'control').map((c) => c.id)).toEqual(['A12', 'A20', 'A27', 'A28']);
    expect(AUTHORIZATION_CASES.filter((c) => c.staleCase).map((c) => c.id)).toEqual(['A13', 'A14', 'A15', 'A16', 'A17', 'A19', 'A26']);
  });
});

writeArtifactsIfRequested();
