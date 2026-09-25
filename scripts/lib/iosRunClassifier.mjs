/**
 * iosRunClassifier.mjs: classify an iOS simulator run as PASS, FAILURE or
 * INFRASTRUCTURE, and derive the streak the leg must reach before it blocks.
 *
 * Rule (ledger L13): INFRASTRUCTURE only when the first failing step precedes
 * the first app assertion AND the pre-assertion log matches a signature in
 * scripts/ios-infra-signatures.json. Anything else that failed is FAILURE.
 * Where the evidence is missing (no assertion step, no log, no start marker)
 * the answer is FAILURE.
 *
 * Only runs on the pinned Intel runner count. A run whose "Set up job" log
 * names an arm64 image is EXCLUDED: it neither counts nor resets the streak,
 * because arm64 images crash the simulator's host GPU service (L13). A run
 * with no recorded image is classified as usual.
 *
 * Pure: no IO, no process, no network.
 */

export const SCRIPT_START_MARKER = 'OLV-IOS-SCRIPT-START';
export const FIRST_ASSERTION_MARKER = 'OLV-IOS-FIRST-ASSERTION';
export const REQUIRED_STREAK = 20;
export const UNRELIABLE_INFRA_SHARE = 0.2;

/** The `Image:` line of a "Set up job" log, or null when it has none. */
export function runnerImage(setupLog) {
  const m = /^(?:.*?\s)?Image:\s*(\S+)\s*$/m.exec(setupLog ?? '');
  return m ? m[1] : null;
}

/** Why a run on `image` is excluded from the streak, or null when it counts. */
export function exclusionReason(image) {
  if (image && /arm64/i.test(image)) return `runner image ${image} is not the pinned Intel runner`;
  return null;
}

const OK = new Set(['success', 'skipped', 'neutral', null, undefined, '']);

/** Compile the checked-in signature list once. */
export function compileSignatures(list) {
  return list.signatures.map((s) => ({
    id: s.id,
    re: new RegExp(s.pattern, 'i'),
    steps: s.steps ? new RegExp(s.steps, 'i') : null,
    before: s.before ?? null,
  }));
}

function matchSignature(signatures, text, stepName) {
  for (const s of signatures) {
    if (s.steps && !(stepName && s.steps.test(stepName))) continue;
    let scope = text;
    if (s.before) {
      const at = scope.indexOf(s.before);
      if (at >= 0) scope = scope.slice(0, at);
    }
    if (s.re.test(scope)) return s.id;
  }
  return null;
}

/**
 * Lines of `gh run view --log-failed` output (`job<TAB>step<TAB>line`) that
 * belong to one step. Text in any other shape is returned unchanged.
 */
export function stepLog(logText, stepName) {
  const lines = logText.split('\n');
  const tabbed = lines.filter((l) => l.split('\t').length >= 3);
  if (tabbed.length === 0) return logText;
  return tabbed.filter((l) => l.split('\t')[1] === stepName).map((l) => l.split('\t').slice(2).join('\t')).join('\n');
}

/**
 * @param {{steps: {name: string, conclusion: string|null}[], firstAssertionStep: string,
 *          logText?: string, conclusion?: string|null}} run
 * @param {ReturnType<typeof compileSignatures>} signatures
 * @returns {{verdict: 'PASS'|'FAILURE'|'INFRASTRUCTURE', signature: string|null, reason: string}}
 */
export function classifyRun(run, signatures) {
  const steps = run.steps ?? [];
  const logText = run.logText ?? '';
  const failIdx = steps.findIndex((s) => !OK.has(s.conclusion));
  const runFailed = !OK.has(run.conclusion);

  if (failIdx < 0 && !runFailed) return { verdict: 'PASS', signature: null, reason: 'no failing step' };

  const fail = (reason) => ({ verdict: 'FAILURE', signature: null, reason });
  let preText;
  let stepName = null;

  if (failIdx < 0) {
    // The job failed with no failing step: only a job that never ran any
    // step (provisioning) is before the assertion.
    if (steps.length > 0) return fail('run failed after all steps succeeded');
    preText = logText;
  } else {
    stepName = steps[failIdx].name;
    const assertIdx = steps.findIndex((s) => s.name === run.firstAssertionStep);
    if (assertIdx < 0) return fail('first-assertion step not found');
    if (failIdx > assertIdx) return fail(`failed at "${stepName}", after the first assertion step`);
    if (failIdx === assertIdx) {
      const start = logText.indexOf(SCRIPT_START_MARKER);
      if (start < 0) return fail('no start marker in the failing step log');
      const assertAt = logText.indexOf(FIRST_ASSERTION_MARKER, start);
      if (assertAt >= 0) return fail('failed at or after the first app assertion');
      preText = logText.slice(start);
    } else {
      preText = logText;
    }
  }

  if (!preText) return fail('no log text to match against');
  const sig = matchSignature(signatures, preText, stepName);
  if (!sig) return fail('failure before the first assertion matches no signature');
  return { verdict: 'INFRASTRUCTURE', signature: sig, reason: `matched ${sig}` };
}

/**
 * Streak over runs in chronological order (oldest first).
 * INFRASTRUCTURE neither counts nor resets; FAILURE resets to 0. EXCLUDED
 * runs are outside the evaluated window: not attempts, not in the 20% guard.
 * @param {{id?: string|number, verdict: 'PASS'|'FAILURE'|'INFRASTRUCTURE'|'EXCLUDED'}[]} all
 */
export function computeStreak(all) {
  const excludedRuns = all.filter((r) => r.verdict === 'EXCLUDED').map((r) => r.id);
  const runs = all.filter((r) => r.verdict !== 'EXCLUDED');
  let streak = 0;
  let infraCount = 0;
  const infraRuns = [];
  for (const r of runs) {
    if (r.verdict === 'PASS') streak += 1;
    else if (r.verdict === 'FAILURE') streak = 0;
    else { infraCount += 1; infraRuns.push(r.id); }
  }
  const attempts = runs.length;
  const unreliable = attempts > 0 && infraCount / attempts > UNRELIABLE_INFRA_SHARE;
  return {
    streak,
    infraCount,
    attempts,
    infraRuns,
    excludedRuns,
    unreliable,
    eligibleToBlock: !unreliable && streak >= REQUIRED_STREAK,
  };
}
