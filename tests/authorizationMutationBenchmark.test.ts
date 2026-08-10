/**
 * authorizationMutationBenchmark.test.ts — the frozen A01–A12 adversarial
 * benchmark for scientific-output authorization. Asserts the three integrity
 * targets on the real authorization machinery: UOAR = 0, ORR = 0, ATR = 1.
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
  writeFileSync(resolve(dir, 'cases.json'), JSON.stringify({ description: 'Frozen scientific-output authorization adversarial benchmark (A01–A12).', cases }, null, 2) + '\n');
  writeFileSync(resolve(dir, 'results.json'), JSON.stringify({
    metrics: { UOAR: score.uoar, ORR: score.orr, ATR: score.atr },
    totals: score.totals,
    results: score.results,
  }, null, 2) + '\n');
  const line = (r: typeof score.results[number]): string =>
    `| ${r.id} | ${r.kind} | ${r.product} | ${r.authorized ? 'authorized' : 'refused'} | ${r.correct ? '✓' : '✗'} | ${r.title} |`;
  writeFileSync(resolve(dir, 'summary.md'),
    `# Authorization integrity benchmark\n\n` +
    `Frozen adversarial cases for scientific-output authorization. Each perturbs a fully-supported baseline and asks whether the existing authorization machinery (\`ProcessService.authorize\` / \`runIfAuthorized\` / \`isAuthenticAuthorization\`) correctly refuses an unsupported output.\n\n` +
    `| Metric | Value | Target |\n|---|---|---|\n` +
    `| UOAR (unsupported authorized) | ${score.uoar} | 0 |\n` +
    `| ORR (valid controls refused) | ${score.orr} | 0 |\n` +
    `| ATR (authorized w/ provenance) | ${score.atr} | 1 |\n\n` +
    `| Case | Kind | Product | Outcome | Correct | What it perturbs |\n|---|---|---|---|---|---|\n` +
    score.results.map(line).join('\n') + '\n');
}

describe('authorization mutation benchmark (A01–A12)', () => {
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

  it('is a frozen 12-case set with exactly one valid control', () => {
    expect(AUTHORIZATION_CASES).toHaveLength(12);
    expect(AUTHORIZATION_CASES.filter((c) => c.kind === 'control')).toHaveLength(1);
    // ids are unique and A01…A12
    const ids = AUTHORIZATION_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(12);
  });
});

writeArtifactsIfRequested();
