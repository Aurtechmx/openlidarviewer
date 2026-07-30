/**
 * Shared derivation for the defect replay: probe planning, outcome and state
 * derivation, and the three comparison files.
 *
 * Both `scripts/replay-defects.mjs` and `scripts/verify-defect-replay.mjs`
 * import this module, which is what makes the verifier a recomputation rather
 * than a second opinion. The runner writes raw records; every value in
 * validation/defects/replay/replay.{json,csv,md} comes out of the functions
 * here, applied to those records. Nothing in the comparison files is
 * transcribed, and nothing in a raw record is a judgement.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REGISTRY_PATH = resolve(HERE, 'validation/defects/defect-registry.json');
export const REPLAY_DIR = resolve(HERE, 'validation/defects/replay');
export const RAW_DIR = resolve(REPLAY_DIR, 'raw');
export const BASELINE_REF = 'v0.6.1';

/**
 * The six states. They are kept apart on purpose: each says something
 * different about what the replay established, and collapsing any of them into
 * a pass or a zero would state more than the run supports.
 *
 * `non-discriminating` used to be folded into `inconclusive`, which put two
 * unlike things in one bucket: a probe that passed on both trees, and a probe
 * whose pair produced nothing readable. The first is a property of the probe
 * and will not change on a re-run; the second is a property of the run and may.
 * Only the first tells a reader that the probe cannot bear on the defect at
 * all, so it is named.
 */
export const STATES = [
  'reproduced-then-fixed',
  'component-absent-at-baseline',
  'environment-unavailable',
  'non-discriminating',
  'not-executed',
  'inconclusive',
];

export const STATE_MEANING = {
  'reproduced-then-fixed':
    'the probe failed at the baseline on the behaviour the record describes, and passes at the candidate',
  'component-absent-at-baseline':
    'the probe could not observe the baseline at all, because a module it imports or a binding it calls did not exist in that tree',
  'environment-unavailable':
    'the probe needs a runtime this host does not offer',
  'non-discriminating':
    'the probe passed on both trees, so it demonstrates nothing about the old behaviour and is not evidence for this record',
  'not-executed':
    'the registry names no separately executable artifact for this entry, so nothing was run for it',
  'inconclusive':
    'the pair produced no readable result on one side or the other, so nothing can be read off it',
};

/* ------------------------------------------------------------- primitives */

export function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Deterministic JSON with sorted keys, so a digest over it is stable. */
export function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2);
}

/**
 * Replace absolute tree roots with stable placeholders at capture time.
 *
 * A raw record has to be readable on another machine and has to compare equal
 * across runs, and a transcript full of one host's directory layout does
 * neither. Longest root first, so a nested root is not half-replaced.
 */
export function redactRoots(text, roots) {
  let out = text;
  for (const { from, to } of [...roots].sort((a, b) => b.from.length - a.from.length)) {
    out = out.split(from).join(to);
  }
  return out;
}

/* -------------------------------------------------------- probe planning */

/**
 * Turn the registry into the list of probes to run.
 *
 * A registry case entry is either a test title in the record's regression file,
 * a `path: title` pair naming a different file, or prose. Only the first two
 * are executable, and prose is recorded as such rather than counted as
 * anything. A record whose regression artifact is a script runs that script.
 */
export function planProbes(registry, treeDir) {
  const probes = [];
  for (const defect of registry.defects) {
    const file = defect.regressionTest.file;
    const cases = defect.regressionTest.cases;
    let index = 0;
    const push = (p) => { probes.push({ defect: defect.id, index: index++, ...p }); };

    if (file.endsWith('.mjs')) {
      push({
        kind: existsSync(resolve(treeDir, file)) ? 'script' : 'none',
        file,
        case: null,
        registryCase: null,
        reason: existsSync(resolve(treeDir, file)) ? null : 'the named script is not in the candidate tree',
      });
      for (const c of cases) {
        push({
          kind: 'none',
          file,
          case: null,
          registryCase: c,
          reason: 'the registry states this in prose about the script run above; it is not a separately addressable case',
        });
      }
      continue;
    }

    let executable = 0;
    for (const c of cases) {
      const m = /^((?:tests|scripts|benchmarks)\/[^:]+):\s*(.+)$/.exec(c);
      const caseFile = m ? m[1] : file;
      const title = m ? m[2] : c;
      const abs = resolve(treeDir, caseFile);
      if (!existsSync(abs)) {
        push({ kind: 'none', file: caseFile, case: null, registryCase: c, reason: 'the named file is not in the candidate tree' });
        continue;
      }
      if (!readFileSync(abs, 'utf8').includes(title)) {
        push({ kind: 'none', file: caseFile, case: null, registryCase: c, reason: 'the registry states this in prose; no test of that title exists in the named file' });
        continue;
      }
      executable += 1;
      push({ kind: 'vitest-case', file: caseFile, case: title, registryCase: c, reason: null });
    }

    if (executable === 0) {
      const abs = resolve(treeDir, file);
      push({
        kind: existsSync(abs) ? 'vitest-file' : 'none',
        file,
        case: null,
        registryCase: null,
        reason: existsSync(abs)
          ? 'the registry names no test title for this record, so its regression file is run whole'
          : 'the named regression file is not in the candidate tree',
      });
    }
  }
  return probes;
}

/* ------------------------------------------------------ outcome from a run */

const MODULE_MISSING = /Cannot find module ['"]([^'"]+)['"]|Failed to (?:load|resolve) (?:url|import) ['"]?([^'"\s]+)/;
const RUNTIME_MISSING = /navigator\.gpu|WebGPU is not available|browserType\.launch|Executable doesn't exist|requires a browser/i;

/**
 * A failure that is only "the imported binding this probe calls is not a
 * function".
 *
 * Such a failure says the symbol did not exist in that tree. It does not show
 * the old behaviour: the probe threw on its first call and observed nothing
 * about what the code did. Counting it as a reproduction would credit the
 * absence of the fix's own helper as evidence of the fault the helper replaced.
 *
 * The pattern names the vite SSR transform's import wrapper on purpose. A bare
 * `x.y is not a function` also fires on a method call against a runtime object,
 * which is an ordinary behavioural failure and must keep its reading.
 */
const ABSENT_BINDING = /__vite_ssr_import_\d+__\.([A-Za-z_$][\w$]*)\)? is not a function/;

/**
 * Read one raw record and say what the run did. Pure: the same record always
 * gives the same answer, and it reads only captures, never a stored judgement.
 */
export function deriveOutcome(record) {
  const t = record.transcript ?? '';
  if (record.timedOut) {
    return { outcome: 'timed-out', detail: `no result within the run timeout`, exitCode: record.exitCode };
  }
  // A missing runtime is only a missing runtime when it stopped the probe from
  // running at all. The same words turn up inside an assertion message from a
  // probe that ran fine and disagreed about a number, and reading that as an
  // unavailable environment would hide a real result behind an excuse.
  const ranNothing = record.probeKind === 'script'
    || record.reporterJson == null
    || (() => { try { return (JSON.parse(record.reporterJson).numTotalTests ?? 0) === 0; } catch { return true; } })();
  if (RUNTIME_MISSING.test(t) && record.exitCode !== 0 && ranNothing) {
    return { outcome: 'runtime-unavailable', detail: firstLine(t.match(RUNTIME_MISSING)?.[0] ?? ''), exitCode: record.exitCode };
  }

  if (record.probeKind === 'script') {
    if (record.exitCode === 0) return { outcome: 'passed', detail: 'the script exited 0', exitCode: record.exitCode };
    const miss = MODULE_MISSING.exec(t);
    if (miss) return { outcome: 'failed-to-load', detail: `missing module ${miss[1] ?? miss[2]}`, exitCode: record.exitCode };
    return { outcome: 'failed', detail: firstMeaningfulLine(t), exitCode: record.exitCode };
  }

  if (record.reporterJson == null) {
    return { outcome: 'no-reporter-output', detail: 'the run produced no reporter file', exitCode: record.exitCode };
  }
  let j;
  try {
    j = JSON.parse(record.reporterJson);
  } catch {
    return { outcome: 'no-reporter-output', detail: 'the reporter file is not readable JSON', exitCode: record.exitCode };
  }

  const suiteMessages = (j.testResults ?? [])
    .filter((s) => (s.assertionResults ?? []).length === 0 && typeof s.message === 'string' && s.message.trim() !== '')
    .map((s) => s.message.trim());

  if (suiteMessages.length > 0 && (j.numTotalTests ?? 0) === 0) {
    const miss = MODULE_MISSING.exec(suiteMessages.join('\n'));
    if (miss) {
      return {
        outcome: 'failed-collection',
        detail: `the probe could not load: missing module ${miss[1] ?? miss[2]}`,
        missingModule: miss[1] ?? miss[2],
        exitCode: record.exitCode,
      };
    }
    return { outcome: 'failed-collection', detail: firstLine(suiteMessages[0]), exitCode: record.exitCode };
  }

  if ((j.numTotalTests ?? 0) === 0) {
    return { outcome: 'no-matching-case', detail: 'the named title matched no test in that tree', exitCode: record.exitCode };
  }

  const assertions = (j.testResults ?? []).flatMap((s) => s.assertionResults ?? []);
  const selected = record.probeCase
    ? assertions.filter((a) => (a.fullName ?? a.title ?? '').includes(record.probeCase))
    : assertions;
  const failed = selected.filter((a) => a.status === 'failed');

  if (record.probeCase && selected.length === 0) {
    return { outcome: 'no-matching-case', detail: 'the named title matched no test in that tree', exitCode: record.exitCode };
  }
  if (failed.length > 0) {
    // Only when EVERY failed case is an absent binding. A probe that failed on
    // an absent helper AND on a value did observe the value, so it keeps the
    // behavioural reading.
    const bindings = failed.map((a) => ABSENT_BINDING.exec((a.failureMessages ?? []).join('\n'))?.[1] ?? null);
    return {
      outcome: 'failed-assertion',
      detail: firstLine((failed[0].failureMessages ?? []).join('\n')) || 'assertion failed with no message',
      failedCases: failed.map((a) => a.fullName ?? a.title ?? '').sort(),
      absentBinding: bindings.every((b) => b !== null) ? bindings[0] : null,
      exitCode: record.exitCode,
    };
  }
  if (record.exitCode !== 0) {
    return { outcome: 'failed', detail: firstMeaningfulLine(t), exitCode: record.exitCode };
  }
  return {
    outcome: 'passed',
    detail: `${selected.length} case${selected.length === 1 ? '' : 's'} passed`,
    exitCode: record.exitCode,
  };
}

function firstLine(text) {
  return (text ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
}

function firstMeaningfulLine(text) {
  const lines = (text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  return lines.find((l) => /error|fail|refus|expected/i.test(l)) ?? lines[0] ?? '';
}

/* -------------------------------------------------------- state of a pair */

/**
 * Derive the state of one probe from its baseline and candidate runs.
 *
 * The baseline full-suite exit code recorded in the registry is not consulted
 * here and must not be. A green suite establishes that the suite passed on the
 * defective tree, not that anything in it reached the code path, so reachability
 * at the baseline is whatever THIS probe showed and nothing else.
 */
export function deriveState(probe, baseline, candidate) {
  if (probe.kind === 'none') {
    return { state: 'not-executed', why: probe.reason };
  }
  if (!baseline || !candidate) {
    return { state: 'inconclusive', why: 'the pair is incomplete: one side produced no record' };
  }
  const b = deriveOutcome(baseline);
  const c = deriveOutcome(candidate);

  if (b.outcome === 'runtime-unavailable' || c.outcome === 'runtime-unavailable') {
    return { state: 'environment-unavailable', why: `the probe needs a runtime this host does not offer: ${b.outcome === 'runtime-unavailable' ? b.detail : c.detail}` };
  }
  // A probe that never loaded observed nothing. It cannot be read as the old
  // behaviour showing itself, whatever the exit code says: the exit code is
  // then about the loader, not about the code under test.
  if (b.outcome === 'failed-collection' || b.outcome === 'failed-to-load') {
    if (b.missingModule) {
      return { state: 'component-absent-at-baseline', why: `the probe could not load at the baseline: ${b.missingModule} did not exist in that tree` };
    }
    return { state: 'inconclusive', why: `the probe did not load at the baseline (${b.detail}), so it observed nothing there` };
  }
  if (b.outcome === 'timed-out' || c.outcome === 'timed-out') {
    return { state: 'inconclusive', why: 'a side produced no result within the run timeout' };
  }
  if (b.outcome === 'no-reporter-output' || c.outcome === 'no-reporter-output') {
    return { state: 'inconclusive', why: 'a side produced no reporter output, so nothing can be read off it' };
  }
  if (b.outcome === 'no-matching-case') {
    return { state: 'inconclusive', why: 'the probe title matched no test at the baseline, so reachability there was not established' };
  }
  if (c.outcome !== 'passed') {
    return { state: 'inconclusive', why: `the candidate side did not pass (${c.outcome}: ${c.detail}), so the pair shows no corrected behaviour` };
  }
  if (b.outcome === 'passed') {
    return { state: 'non-discriminating', why: 'the probe passes on the baseline tree as well, so it demonstrates nothing about the old behaviour' };
  }
  // Before reading a baseline failure as a reproduction, check what failed. A
  // probe that threw because the binding it calls was absent established the
  // absence of that symbol, not the behaviour the record describes.
  if (b.absentBinding) {
    return {
      state: 'component-absent-at-baseline',
      why: `the probe called ${b.absentBinding} at the baseline and that binding did not exist in that tree, so it observed nothing about the old behaviour`,
    };
  }
  if (b.outcome === 'failed-assertion' || b.outcome === 'failed') {
    return { state: 'reproduced-then-fixed', why: `the baseline run ${b.outcome === 'failed-assertion' ? 'failed the assertion' : 'failed'} (${b.detail}); the candidate run passes` };
  }
  return { state: 'inconclusive', why: `unclassified baseline outcome ${b.outcome}` };
}

/**
 * Precedence when one record has several probes. Documented, and stable.
 *
 * `non-discriminating` sits below `inconclusive` because it is the weaker
 * report of the two: a probe that passed on both trees says the probe cannot
 * bear on the record, while an inconclusive pair says the run itself did not
 * settle. A record whose only executable probe passed on both sides therefore
 * reads non-discriminating, and never reproduced-then-fixed.
 */
export const DEFECT_STATE_PRECEDENCE = [
  'reproduced-then-fixed',
  'component-absent-at-baseline',
  'environment-unavailable',
  'inconclusive',
  'non-discriminating',
  'not-executed',
];

export function probeStates(probes, records) {
  const find = (p, label) => records.find(
    (r) => r.defect === p.defect && r.probeIndex === p.index && r.environment.label === label,
  );
  return probes.map((p) => {
    const baseline = find(p, 'baseline');
    const candidate = find(p, 'candidate');
    const { state, why } = deriveState(p, baseline, candidate);
    return { probe: p, baseline, candidate, state, why };
  });
}

export function deriveDefectState(id, probes, records) {
  const mine = probeStates(probes, records).filter((s) => s.probe.defect === id);
  if (mine.length === 0) return 'not-executed';
  for (const state of DEFECT_STATE_PRECEDENCE) {
    if (mine.some((s) => s.state === state)) return state;
  }
  return 'inconclusive';
}

/* -------------------------------------------------- cross-encoding checks */

/**
 * Compare two independent encodings of the same run against each other.
 *
 * A raw record holds the vitest counts twice: once in the reporter JSON and
 * once in the human summary the same process printed. They are written by
 * different code paths and neither is derived from the other, so an edit to one
 * shows up as a disagreement here no matter how carefully the digests around it
 * are refreshed. That is the point: the verifier never accepts a hash as
 * evidence about the thing it hashes.
 */
export function crossCheck(record) {
  const problems = [];
  const t = record.transcript ?? '';

  // `<home>/` and `<repo>/` are the placeholders, so a path that still carries
  // segments after one of them is a directory layout that survived redaction.
  // Checking only for the raw prefixes passes on `<home>/Documents/...`, which
  // is the leak this guard exists to stop.
  const markers = ['/Users/', '/home/', '/private/tmp/', '/var/folders/', '<home>/', '<repo>/'];
  for (const marker of markers) {
    if (t.includes(marker) || (record.reporterJson ?? '').includes(marker)) {
      problems.push(`an absolute path survived redaction (${marker})`);
    }
  }

  if (record.probeKind === 'script' || record.reporterJson == null) return problems;

  let j;
  try {
    j = JSON.parse(record.reporterJson);
  } catch {
    problems.push('the reporter capture is not readable JSON');
    return problems;
  }

  const testsLine = /^\s*Tests\s+(.+?)\s*$/m.exec(t);
  if (testsLine) {
    const text = testsLine[1];
    if (/no tests/.test(text)) {
      if ((j.numTotalTests ?? 0) !== 0) {
        problems.push(`the transcript reports no tests while the reporter capture counts ${j.numTotalTests}`);
      }
    } else {
      const total = /\((\d+)\)\s*$/.exec(text);
      if (total && Number(total[1]) !== (j.numTotalTests ?? 0)) {
        problems.push(`transcript test total ${total[1]} against reporter total ${j.numTotalTests}`);
      }
      const failed = /(\d+)\s+failed/.exec(text);
      const reported = j.numFailedTests ?? 0;
      if (Number(failed?.[1] ?? 0) !== reported) {
        problems.push(`transcript failed count ${failed?.[1] ?? 0} against reporter failed count ${reported}`);
      }
    }
  } else if ((j.numTotalTests ?? 0) > 0) {
    problems.push('the reporter capture counts tests the transcript never summarised');
  }

  // File count against file count. The reporter's suite counters count describe
  // blocks, which is a different quantity from the files the summary line
  // counts, so comparing those two would fire on every healthy run.
  const filesLine = /^\s*Test Files\s+(.+?)\s*$/m.exec(t);
  if (filesLine) {
    const total = /\((\d+)\)\s*$/.exec(filesLine[1]);
    const reported = (j.testResults ?? []).length;
    if (total && Number(total[1]) !== reported) {
      problems.push(`transcript file total ${total[1]} against reporter file total ${reported}`);
    }
  }

  const success = j.success === true;
  if (success && record.exitCode !== 0) {
    problems.push(`the reporter capture says the run succeeded while the exit code is ${record.exitCode}`);
  }
  if (!success && record.exitCode === 0) {
    problems.push('the reporter capture says the run did not succeed while the exit code is 0');
  }
  return problems;
}

/* ------------------------------------------------------- comparison files */

function esc(v) {
  const s = v == null ? '' : lf(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// One line-ending convention for every derived string, chosen so a record
// captured on Windows and one captured on POSIX render the same bytes: LF.
// CRLF and lone CR both collapse to LF before anything else looks at the text.
export function lf(v) {
  return String(v ?? '').replace(/\r\n?/g, '\n');
}

export function mdCell(v) {
  // Backslash first: escaping the pipe alone turns a literal `\` before a
  // `|` into `\\|`, which markdown renders as a backslash plus a cell break.
  return lf(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// Inline code spans are the opposite case from mdCell: CommonMark performs no
// backslash processing inside a code span, so running the text escaper over a
// command turned `-t "\"vertical\""` into `-t "\\"vertical\\""` and the page
// showed a command that would not run. Code-span content goes in verbatim; the
// only things that need handling are backticks, which are closed by widening
// the fence, and newlines, which would end the span.
export function mdCode(v) {
  const s = lf(v).replace(/\n/g, ' ');
  const longestRun = [...s.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length), 0);
  const fence = '`'.repeat(longestRun + 1);
  // A code span whose content starts or ends with a backtick, or is all
  // spaces, needs one padding space each side; CommonMark strips exactly one.
  const pad = s.startsWith('`') || s.endsWith('`') || /^ +$/.test(s) ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

export function renderComparisons(registry, probes, records) {
  const states = probeStates(probes, records);
  const byDefect = new Map(registry.defects.map((d) => [d.id, d]));

  // The three comparison files are projections of these rows and of nothing
  // else, so JSON, CSV and Markdown cannot disagree about a value. Free text
  // is normalised to LF once, here, rather than per format.
  const rows = states.map((s) => {
    const d = byDefect.get(s.probe.defect);
    const bOut = s.baseline ? deriveOutcome(s.baseline) : null;
    const cOut = s.candidate ? deriveOutcome(s.candidate) : null;
    const side = (rec, out) => (rec ? {
      commit: rec.environment.commit,
      ref: rec.environment.ref,
      command: lf(rec.command),
      exitCode: rec.exitCode,
      outcome: out.outcome,
      observation: lf(out.detail),
      durationMs: rec.durationMs,
      transcriptDigest: digestOf(rec.transcript),
      reporterDigest: rec.reporterJson == null ? null : digestOf(rec.reporterJson),
      injectedFileCount: rec.injectedFiles.length,
    } : null);
    return {
      defect: s.probe.defect,
      defectName: d.name,
      severity: d.severity,
      fixCommit: d.fixCommit,
      probeIndex: s.probe.index,
      probeKind: s.probe.kind,
      probeFile: s.probe.file,
      probeCase: s.probe.case,
      registryCase: s.probe.registryCase,
      state: s.state,
      why: s.why,
      expectedOldBehaviour: d.observed,
      expectedCorrectedBehaviour: d.expected,
      regressionTest: d.regressionTest.file,
      baseline: side(s.baseline, bOut),
      candidate: side(s.candidate, cOut),
    };
  });

  const defectRows = registry.defects.map((d) => ({
    id: d.id,
    name: d.name,
    severity: d.severity,
    fixCommit: d.fixCommit,
    state: deriveDefectState(d.id, probes, records),
    probes: rows.filter((r) => r.defect === d.id).length,
    probeStates: rows.filter((r) => r.defect === d.id).map((r) => r.state),
  }));

  const tally = (values) => {
    const out = Object.fromEntries(STATES.map((s) => [s, 0]));
    for (const v of values) out[v] += 1;
    return out;
  };

  const environments = records.length === 0 ? [] : ['baseline', 'candidate'].map((label) => {
    const r = records.find((x) => x.environment.label === label);
    return r ? r.environment : null;
  }).filter(Boolean);

  const json = {
    generatedBy: 'scripts/replay-defects.mjs',
    derivedBy: 'scripts/defect-replay-lib.mjs',
    source: 'validation/defects/replay/raw',
    registryVersion: registry.registryVersion,
    scope:
      'The 18 records in validation/defects/defect-registry.json and the regression artifacts those records name. '
      + 'It is not a statement about any other part of the repository.',
    method:
      'Each probe is the regression artifact the registry names for the record. The same probe text and the same '
      + 'fixture run in two trees, the baseline tag and the candidate working tree, sharing one node_modules so the '
      + 'runtime is identical on both sides. Probe files missing from the baseline tree are copied in from the '
      + 'candidate. The baseline tree is returned to the tag before each record, and no file on that record code '
      + 'path is copied, so a probe is never handed the fix it is meant to detect.',
    baselineSuiteCaveat:
      'The registry records a full-suite run at the baseline tag that exited 0. That exit code is not read here and '
      + 'establishes nothing per defect: a green suite says the suite passed while the defective code was present, '
      + 'not that any test in it reached a given code path. Where a probe did not establish reachability at the '
      + 'baseline, its state says in which way it did not, and the reason beside it says why.',
    discriminationCaveat:
      'A probe is evidence for a record only if it failed at the baseline and passed at the candidate. Two kinds of '
      + 'probe fail that test and are counted apart from it. A probe that passed on both trees is non-discriminating: '
      + 'it shows nothing about the old behaviour, whether it was written as a control for the case beside it or it '
      + 'exercises a sibling path the defect never touched. A probe whose baseline failure was an absent binding is '
      + 'component-absent-at-baseline: the call threw before it reached the code under test, so no behaviour was '
      + 'observed there. Neither group is counted under reproduced-then-fixed, at the probe level or the record level.',
    stateMeanings: STATE_MEANING,
    defectStatePrecedence: DEFECT_STATE_PRECEDENCE,
    environments,
    totals: {
      defects: registry.defects.length,
      probes: probes.length,
      runs: records.length,
      byDefectState: tally(defectRows.map((d) => d.state)),
      byProbeState: tally(rows.map((r) => r.state)),
    },
    defects: defectRows,
    probeRuns: rows,
  };

  const csvHeader = [
    'defect', 'defectState', 'probeIndex', 'probeKind', 'probeFile', 'probeCase',
    'probeState', 'why', 'fixCommit',
    'baselineCommit', 'baselineCommand', 'baselineExitCode', 'baselineOutcome', 'baselineObservation', 'baselineTranscriptDigest',
    'candidateCommit', 'candidateCommand', 'candidateExitCode', 'candidateOutcome', 'candidateObservation', 'candidateTranscriptDigest',
    'expectedOldBehaviour', 'expectedCorrectedBehaviour', 'regressionTest',
  ];
  const defectState = new Map(defectRows.map((d) => [d.id, d.state]));
  const csv = [
    csvHeader.join(','),
    ...rows.map((r) => [
      r.defect, defectState.get(r.defect), r.probeIndex, r.probeKind, r.probeFile, r.probeCase,
      r.state, r.why, r.fixCommit,
      r.baseline?.commit, r.baseline?.command, r.baseline?.exitCode, r.baseline?.outcome, r.baseline?.observation, r.baseline?.transcriptDigest,
      r.candidate?.commit, r.candidate?.command, r.candidate?.exitCode, r.candidate?.outcome, r.candidate?.observation, r.candidate?.transcriptDigest,
      r.expectedOldBehaviour, r.expectedCorrectedBehaviour, r.regressionTest,
    ].map(esc).join(',')),
  ].join('\n') + '\n';

  const md = [];
  md.push('# Defect replay, baseline against candidate');
  md.push('');
  md.push('Generated by `scripts/replay-defects.mjs` from the raw records in');
  md.push('`validation/defects/replay/raw/`. Do not edit this file. Every value below is');
  md.push('recomputed from those records by `npm run validation:defects:replay:verify`.');
  md.push('');
  md.push(`Records: ${registry.defects.length}. Probes: ${probes.length}. Runs: ${records.length}.`);
  md.push('');
  md.push('## Scope');
  md.push('');
  md.push(json.scope);
  md.push('');
  md.push('## Method');
  md.push('');
  md.push(json.method);
  md.push('');
  md.push(json.baselineSuiteCaveat);
  md.push('');
  md.push('## What counts as evidence');
  md.push('');
  md.push(json.discriminationCaveat);
  md.push('');
  if (environments.length > 0) {
    md.push('| side | ref | commit | node | vitest | platform |');
    md.push('| --- | --- | --- | --- | --- | --- |');
    for (const e of environments) {
      md.push(`| ${e.label} | ${mdCell(e.ref)} | ${e.commitShort} | ${e.node} | ${e.vitest} | ${e.platform} |`);
    }
    md.push('');
  }
  md.push('## States');
  md.push('');
  md.push('| state | meaning |');
  md.push('| --- | --- |');
  for (const s of STATES) md.push(`| ${s} | ${mdCell(STATE_MEANING[s])} |`);
  md.push('');
  md.push('## Records by state');
  md.push('');
  md.push('| state | records | probe runs |');
  md.push('| --- | --- | --- |');
  for (const s of STATES) {
    md.push(`| ${s} | ${json.totals.byDefectState[s]} | ${json.totals.byProbeState[s]} |`);
  }
  md.push('');
  md.push('A record with more than one probe takes the first state its probes reach in');
  md.push(`this order: ${DEFECT_STATE_PRECEDENCE.join(', ')}. The probe column above counts every run pair, so the two columns do not sum alike.`);
  md.push('');
  md.push('## Record by record');
  md.push('');
  md.push('| record | state | probes | fixing commit |');
  md.push('| --- | --- | --- | --- |');
  for (const d of defectRows) {
    md.push(`| ${d.id} | ${d.state} | ${d.probes} | ${d.fixCommit} |`);
  }
  md.push('');
  md.push('## Probe runs');
  md.push('');
  md.push('| record | probe | state | baseline exit | baseline outcome | candidate exit | candidate outcome |');
  md.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of rows) {
    md.push(`| ${r.defect} | ${r.probeIndex} | ${r.state} | ${r.baseline?.exitCode ?? 'n/a'} | ${r.baseline?.outcome ?? 'not run'} | ${r.candidate?.exitCode ?? 'n/a'} | ${r.candidate?.outcome ?? 'not run'} |`);
  }
  md.push('');
  md.push('## What each probe observed');
  md.push('');
  for (const r of rows) {
    md.push(`### ${r.defect} probe ${r.probeIndex}`);
    md.push('');
    md.push(`- state: ${r.state}`);
    md.push(`- why: ${mdCell(r.why)}`);
    md.push(`- probe: ${r.probeKind}, ${mdCode(r.probeFile)}${r.probeCase ? `, case "${mdCell(r.probeCase)}"` : ''}`);
    if (r.registryCase && !r.probeCase) md.push(`- registry entry: ${mdCell(r.registryCase)}`);
    if (r.baseline) {
      md.push(`- baseline: ${mdCode(r.baseline.command)} exit ${r.baseline.exitCode}, ${r.baseline.outcome}: ${mdCell(r.baseline.observation)}`);
      md.push(`- baseline transcript digest: ${r.baseline.transcriptDigest}`);
    }
    if (r.candidate) {
      md.push(`- candidate: ${mdCode(r.candidate.command)} exit ${r.candidate.exitCode}, ${r.candidate.outcome}: ${mdCell(r.candidate.observation)}`);
      md.push(`- candidate transcript digest: ${r.candidate.transcriptDigest}`);
    }
    md.push(`- expected old behaviour: ${mdCell(r.expectedOldBehaviour)}`);
    md.push(`- expected corrected behaviour: ${mdCell(r.expectedCorrectedBehaviour)}`);
    md.push('');
  }

  return {
    'replay.json': `${canonicalJson(json)}\n`,
    'replay.csv': csv,
    // LF joins throughout and exactly one trailing newline, so the file is the
    // same bytes wherever it was generated.
    'replay.md': `${md.join('\n').replace(/\n+$/, '')}\n`,
  };
}
