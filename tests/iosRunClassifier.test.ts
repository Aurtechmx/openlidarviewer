/**
 * The iOS simulator leg's run classifier (ledger L13): INFRASTRUCTURE only for
 * a signature-matched failure before the first app assertion.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRun, compileSignatures, computeStreak, stepLog,
  SCRIPT_START_MARKER, FIRST_ASSERTION_MARKER, type Verdict, type SignatureList,
} from '../scripts/lib/iosRunClassifier.mjs';
import { evaluate, format } from '../scripts/ios-streak.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIST: SignatureList = JSON.parse(readFileSync(resolve(ROOT, 'scripts/ios-infra-signatures.json'), 'utf8'));
const SIGS = compileSignatures(LIST);
const ASSERT = LIST.firstAssertionStep;

const STEPS = ['Set up job', 'setup-node', 'npm ci --ignore-scripts', 'Boot the simulator',
  'Install Appium and the XCUITest driver', 'Build WebDriverAgent', ASSERT, 'Capture the screen'];
const failingAt = (name: string) => STEPS.map((n) => ({
  name: n,
  conclusion: n === name ? 'failure' : STEPS.indexOf(n) < STEPS.indexOf(name) ? 'success' : 'skipped',
}));
const run = (failStep: string, logText: string) =>
  classifyRun({ steps: failingAt(failStep), firstAssertionStep: ASSERT, logText, conclusion: 'failure' }, SIGS);

describe('signature list', () => {
  it('has an id and a note per signature, and the four signature classes', () => {
    for (const s of LIST.signatures) { expect(s.id).toBeTruthy(); expect(s.note).toBeTruthy(); }
    expect(LIST.signatures.map((s) => s.id)).toEqual([
      'runner-provisioning', 'dependency-download-network', 'simulator-runtime-missing', 'wda-unreachable-8100']);
  });
  it('the touch check prints both markers, the assertion marker before the first assertion', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/ios-touch-check.mjs'), 'utf8');
    expect(src).toContain(`'${SCRIPT_START_MARKER}'`);
    expect(src).toContain(`'${FIRST_ASSERTION_MARKER}'`);
    expect(src.indexOf('console.log(FIRST_ASSERTION_MARKER)')).toBeLessThan(src.indexOf("record('test seam armed'"));
    expect(src.indexOf("record('session created'")).toBeLessThan(src.indexOf('console.log(FIRST_ASSERTION_MARKER)'));
  });
});

describe('classifyRun', () => {
  it('PASS when no step fails', () => {
    const steps = STEPS.map((name) => ({ name, conclusion: 'success' }));
    expect(classifyRun({ steps, firstAssertionStep: ASSERT, conclusion: 'success' }, SIGS).verdict).toBe('PASS');
  });

  it('runner provisioning: a job that ran no steps', () => {
    const r = classifyRun({ steps: [], firstAssertionStep: ASSERT, conclusion: 'failure',
      logText: 'The runner has received a shutdown signal.' }, SIGS);
    expect(r).toMatchObject({ verdict: 'INFRASTRUCTURE', signature: 'runner-provisioning' });
    expect(run('Set up job', 'lost communication with the server').signature).toBe('runner-provisioning');
  });

  it.each(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])('dependency download network error %s', (code) => {
    const r = run('Install Appium and the XCUITest driver', `fetch GET https://nodejs.org/x.tar.gz failed with ${code}`);
    expect(r).toMatchObject({ verdict: 'INFRASTRUCTURE', signature: 'dependency-download-network' });
  });

  it('a network error outside the download steps is not the download signature', () => {
    expect(run('Build WebDriverAgent', 'ECONNRESET').verdict).toBe('FAILURE');
  });

  it('simulator runtime missing', () => {
    expect(run('Boot the simulator', '::error::no iPhone simulator is available on this image'))
      .toMatchObject({ verdict: 'INFRASTRUCTURE', signature: 'simulator-runtime-missing' });
  });

  it('WebDriverAgent unreachable on :8100 before the session opens', () => {
    const log = `${SCRIPT_START_MARKER}\nError: connect ECONNREFUSED 127.0.0.1:8100\n`;
    expect(run(ASSERT, log)).toMatchObject({ verdict: 'INFRASTRUCTURE', signature: 'wda-unreachable-8100' });
  });

  it('a :8100 error after the session opened is not the WDA signature', () => {
    const log = `${SCRIPT_START_MARKER}\nok    session created\nconnect ECONNREFUSED 127.0.0.1:8100\n`;
    expect(run(ASSERT, log).verdict).toBe('FAILURE');
  });

  it('FAILURE after the first assertion even when the text matches a signature', () => {
    const log = `${SCRIPT_START_MARKER}\nok    session created\n${FIRST_ASSERTION_MARKER}\nconnect ECONNREFUSED 127.0.0.1:8100 ENOTFOUND`;
    expect(run(ASSERT, log).verdict).toBe('FAILURE');
    expect(run('Capture the screen', 'The runner has received a shutdown signal.').verdict).toBe('FAILURE');
  });

  it('no start marker in the assertion step is FAILURE', () => {
    expect(run(ASSERT, 'connect ECONNREFUSED 127.0.0.1:8100').verdict).toBe('FAILURE');
  });

  it('assertion step not present is FAILURE', () => {
    const steps = [{ name: 'Boot the simulator', conclusion: 'failure' }];
    expect(classifyRun({ steps, firstAssertionStep: ASSERT, logText: 'no iPhone simulator is available on this image' }, SIGS).verdict)
      .toBe('FAILURE');
  });

  it('no log text, or no matching signature, is FAILURE', () => {
    expect(run('Boot the simulator', '').verdict).toBe('FAILURE');
    expect(run('Boot the simulator', 'xcodebuild: error: something else').verdict).toBe('FAILURE');
  });
});

describe('stepLog', () => {
  it('keeps only the named step of gh --log-failed output', () => {
    const text = 'job\tBoot the simulator\tENOTFOUND\njob\tInstall Appium and the XCUITest driver\tfine';
    expect(stepLog(text, 'Install Appium and the XCUITest driver')).toBe('fine');
    expect(stepLog('plain', 'x')).toBe('plain');
  });
});

describe('computeStreak', () => {
  const seq = (s: string) => [...s].map((c, i) => ({
    id: i, verdict: ({ P: 'PASS', F: 'FAILURE', I: 'INFRASTRUCTURE' } as Record<string, Verdict>)[c] }));

  it('counts passes since the last failure', () => {
    expect(computeStreak(seq('PPFPPP')).streak).toBe(3);
  });
  it('INFRASTRUCTURE neither counts nor resets, and is logged by id', () => {
    const r = computeStreak(seq('PPIPP'));
    expect(r).toMatchObject({ streak: 4, infraCount: 1, attempts: 5, infraRuns: [2] });
  });
  it('20 passes make the leg eligible to block', () => {
    expect(computeStreak(seq('F' + 'P'.repeat(20))).eligibleToBlock).toBe(true);
    expect(computeStreak(seq('P'.repeat(19))).eligibleToBlock).toBe(false);
  });
  it('more than 20% INFRASTRUCTURE is unreliable whatever the streak', () => {
    const r = computeStreak(seq('P'.repeat(20) + 'IIIII' + 'I'));
    expect(r.streak).toBe(20);
    expect(r.unreliable).toBe(true);
    expect(r.eligibleToBlock).toBe(false);
    expect(computeStreak(seq('PPPPI')).unreliable).toBe(false); // exactly 20%
  });
});

describe('ios-streak CLI with an injected gh', () => {
  it('classifies runs oldest first without the network', () => {
    const view: Record<string, unknown> = {
      '2': { jobs: [{ conclusion: 'success', steps: STEPS.map((name) => ({ name, conclusion: 'success' })) }] },
      '1': { jobs: [{ conclusion: 'failure', steps: failingAt('Install Appium and the XCUITest driver') }] },
    };
    const gh = (args: string[]) => {
      if (args[1] === 'list') return JSON.stringify([
        { databaseId: 2, status: 'completed', conclusion: 'success', createdAt: 't2', headBranch: 'main' },
        { databaseId: 3, status: 'in_progress', conclusion: '', createdAt: 't3', headBranch: 'main' },
        { databaseId: 1, status: 'completed', conclusion: 'failure', createdAt: 't1', headBranch: 'main' },
      ]);
      if (args.includes('--log-failed')) return 'job\tInstall Appium and the XCUITest driver\tfailed with ENOTFOUND';
      return JSON.stringify(view[args[2]]);
    };
    const r = evaluate({ gh, limit: 10 });
    expect(r.runs.map((x) => [x.id, x.verdict])).toEqual([[1, 'INFRASTRUCTURE'], [2, 'PASS']]);
    expect(r).toMatchObject({ streak: 1, infraCount: 1, attempts: 2, unreliable: true });
    expect(format(r)).toContain('leg: UNRELIABLE');
  });
});
