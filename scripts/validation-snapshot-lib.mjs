/**
 * validation-snapshot-lib.mjs — the derivation shared by the snapshot builder
 * and the snapshot verifier.
 *
 * One rule holds this file together: every number the snapshot states is
 * computed here, from the bytes of the collected records, and nothing is
 * written down twice. The builder runs `deriveSnapshot` over the evidence
 * directory it just filled; the verifier runs the same function over the
 * evidence directory it was handed and compares the result to the stored
 * snapshot. An edit to a collected record therefore has to survive
 * re-derivation, not just a digest, which is what makes refreshing a checksum
 * after an edit useless to whoever made the edit.
 *
 * The function takes a reader rather than a path so both callers drive it the
 * same way, and so it can run in a directory that has no repository around it.
 */

import { createHash } from 'node:crypto';

/** The inputs the snapshot collects, in report order. */
export const INPUTS = Object.freeze([
  {
    id: 'defects',
    title: 'Defect records',
    primary: 'validation/defects/defect-registry.json',
    command: 'node scripts/build-defect-summary.mjs',
    files: [
      'validation/defects/defect-registry.json',
      'validation/defects/defect-registry.schema.json',
      'validation/defects/defect-summary.json',
      'validation/defects/defect-summary.csv',
      'validation/defects/defect-summary.md',
    ],
  },
  {
    id: 'replay',
    title: 'Replay results',
    primary: 'validation/replay/results.json',
    command: 'node validation/replay/run-replay.mjs',
    dir: { path: 'validation/replay', match: /\.(json|md)$/ },
    files: [],
  },
  {
    id: 'reachability',
    title: 'Reachability ledger',
    primary: 'validation/reachability/summary.json',
    command: 'npm run verify:reachability',
    files: ['validation/reachability/claims.json', 'validation/reachability/summary.json'],
  },
  {
    id: 'mutations',
    title: 'Mutation results',
    primary: 'validation/mutations/results.json',
    command: 'node validation/mutations/run-campaign.mjs',
    dir: { path: 'validation/mutations', match: /\.(json|md)$/ },
    files: [],
  },
  {
    id: 'cross-platform',
    title: 'Cross-platform comparison',
    primary: 'docs/validation/evidence/portability-v0.6.2/comparison.json',
    command: 'npm run benchmark:compare-platforms',
    files: [
      'docs/validation/evidence/portability-v0.6.2/comparison.json',
      'docs/validation/evidence/portability-v0.6.2/comparison.csv',
      'docs/validation/evidence/portability-v0.6.2/environments.json',
      'docs/validation/evidence/portability-v0.6.2/manifest.json',
      'docs/validation/evidence/portability-v0.6.2/summary.md',
      'docs/validation/evidence/portability-v0.6.2/PROVENANCE.md',
    ],
  },
  {
    id: 'gdal-cross-checks',
    title: 'GDAL cross-checks',
    primary: 'benchmark-results/crosschecks/results.json',
    command:
      'npx vitest run tests/slopeCrossCheck.test.ts tests/aspectCrossCheck.test.ts tests/hillshadeCrossCheck.test.ts',
    files: [
      'benchmark-results/crosschecks/results.json',
      'tests/fixtures/reference/slope/SHA256SUMS',
      'tests/fixtures/reference/slope/command.txt',
      'tests/fixtures/reference/slope/environment.json',
      'tests/fixtures/reference/aspect/SHA256SUMS',
      'tests/fixtures/reference/aspect/command.txt',
      'tests/fixtures/reference/aspect/environment.json',
      'tests/fixtures/reference/hillshade/SHA256SUMS',
      'tests/fixtures/reference/hillshade/command.txt',
      'tests/fixtures/reference/hillshade/environment.json',
    ],
  },
  {
    id: 'seed-sensitivity',
    title: 'Seed sensitivity',
    primary: 'benchmark-results/seeds/sweep.json',
    command: 'npm run benchmark:seeds',
    files: ['benchmark-results/seeds/sweep.json', 'benchmark-results/seeds/summary.md'],
  },
  {
    id: 'clean-clone',
    title: 'Clean clone',
    primary: 'release/clean-clone.json',
    command: 'npm run benchmark:clean-clone',
    files: ['release/clean-clone.json'],
  },
  {
    id: 'archive-portability',
    title: 'Archive portability',
    primary: 'release/archive-portability.json',
    command: 'npm run benchmark:archive-portability',
    files: ['release/archive-portability.json'],
  },
  {
    id: 'claims',
    title: 'Claims',
    primary: 'docs/validation/claim-register.yaml',
    command: 'npm run gen:claim-registry',
    files: ['docs/validation/claim-register.yaml'],
  },
  {
    id: 'limitations',
    title: 'Known limitations',
    primary: 'KNOWN_LIMITATIONS_v0.6.2.md',
    command: 'written by hand for each version; no generator produces it',
    files: ['KNOWN_LIMITATIONS_v0.6.2.md', 'docs/release/ERRATUM_v0.6.2.md'],
  },
  {
    id: 'environment',
    title: 'Environment',
    primary: 'benchmark-results/latest/environment.json',
    command: 'npm run benchmark:repro',
    files: ['benchmark-results/latest/environment.json'],
  },
  {
    id: 'gate',
    title: 'Release-gate result',
    primary: 'release/test-evidence-v0.6.2.json',
    command: 'npm run evidence',
    files: ['release/test-evidence-v0.6.2.json'],
  },
  {
    id: 'build-identity',
    title: 'Build identity and archive name',
    primary: 'release/package-build-metadata-v0.6.2.json',
    command: 'npm run package',
    files: ['release/package-build-metadata-v0.6.2.json'],
  },
  {
    id: 'identity-sources',
    title: 'Identity sources',
    primary: 'package.json',
    command: 'tracked in the repository; no generator produces it',
    files: [
      'package.json',
      'package-lock.json',
      'CHANGELOG.md',
      'CITATION.cff',
      'README.md',
      'MANIFEST.md',
    ],
  },
]);

/**
 * The evidence-relative path a collected file is stored at.
 *
 * Two names are changed on the way in, both for the same reason: a copy of a
 * record is a record, and it must not be read as the thing it is a copy of. A
 * file named SHA256SUMS is otherwise read as the checksum manifest for the
 * directory it now sits in, and it lists files that were never copied beside
 * it. A markdown copy is otherwise read as shipping documentation, and its
 * links resolve against a directory that carries none of their targets. A
 * dependency manifest is otherwise read as a package to maintain: Dependabot
 * security updates scan every manifest in the repository, and one opened a
 * pull request against the collected `package-lock.json`, which the snapshot
 * manifest hashes and the verifier re-derives. All three take a `.txt`
 * suffix; the derivation keys off the original path, so the suffix changes
 * nothing it computes.
 */
const COLLECTED_AS_TEXT = new Set([
  'SHA256SUMS',
  'package.json',
  'package-lock.json',
]);

export function evidencePath(inputId, repoPath) {
  const parts = repoPath.split('/');
  let last = parts[parts.length - 1];
  if (COLLECTED_AS_TEXT.has(last) || last.endsWith('.md')) last = `${last}.txt`;
  return `evidence/${inputId}/${[...parts.slice(0, -1), last].join('/')}`;
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const WORDS = new Map(
  [
    'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
    'nineteen', 'twenty',
  ].map((w, i) => [w, i]),
);

/** A count written as a word or as digits, or null when it is neither. */
export function countFromText(token) {
  if (token == null) return null;
  const t = token.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORDS.has(t) ? WORDS.get(t) : null;
}

/** The newest dated changelog section, as `{ version, date, body }`. */
export function newestChangelogEntry(text) {
  const m = text.match(/^##\s*\[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]\s*-\s*(\d{4}-\d{2}-\d{2})/m);
  if (!m) return null;
  const start = m.index;
  const rest = text.slice(start + m[0].length);
  const next = rest.search(/^##\s*\[/m);
  return { version: m[1], date: m[2], body: next < 0 ? rest : rest.slice(0, next) };
}

/**
 * The defect composition the changelog entry states in prose.
 *
 * The snapshot derives its own composition from the records and then compares
 * the two. Neither side is copied from the other, so a record set and the text
 * that describes it cannot drift apart without one of these figures moving.
 */
export function declaredComposition(changelogBody) {
  const flat = changelogBody.replace(/\s+/g, ' ');
  const pick = (re) => countFromText(flat.match(re)?.[1] ?? null);
  return {
    total: pick(/\b([A-Za-z]+|\d+) defects are fixed\b/i),
    exposedBySpecializedValidation: pick(/\b([A-Za-z]+|\d+) were exposed by a validation suite\b/i),
    byCodeReview: pick(/\b([A-Za-z]+|\d+) came from code review\b/i),
    carriedFromTheEarlierAudit: pick(/\b([A-Za-z]+|\d+) of those carried from the v[\d.]+ [\w-]+ audit\b/i),
    affectingReleasedStatementsOrOutputs: pick(
      /\b([A-Za-z]+|\d+) defects reached published v[\d.]+ output\b/i,
    ),
  };
}

const CARRIED = /open gap by the v[\d.]+ [\w-]+ audit/i;
const ERRATUM = /docs\/release\/ERRATUM_v[\d.]+\.md/;

/** The composition of the record set, counted over the records themselves. */
export function derivedComposition(registry) {
  const d = registry.defects;
  return {
    total: d.length,
    exposedBySpecializedValidation: d.filter((x) => x.discoveryMethod === 'validation suite').length,
    byCodeReview: d.filter((x) => x.discoveryMethod === 'code review').length,
    carriedFromTheEarlierAudit: d.filter((x) => CARRIED.test(x.discoveryContext ?? '')).length,
    affectingReleasedStatementsOrOutputs: d.filter((x) => ERRATUM.test(x.verificationStatus ?? ''))
      .length,
  };
}

/** Per-severity and per-mechanism counts, sorted for a stable rendering. */
export function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

/**
 * A structural description of a JSON record: its top-level keys, the kind of
 * each, the length of each array and the value of each scalar. Enough that an
 * edit to a collected record changes it, without pinning a schema the record's
 * own producer is free to change.
 */
export function jsonShape(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { parsed: false, reason: err.message };
  }
  if (Array.isArray(value)) return { parsed: true, kind: 'array', length: value.length };
  if (value === null || typeof value !== 'object') return { parsed: true, kind: typeof value };
  const keys = {};
  for (const k of Object.keys(value).sort()) {
    const v = value[k];
    if (Array.isArray(v)) keys[k] = `array[${v.length}]`;
    else if (v === null) keys[k] = 'null';
    else if (typeof v === 'object') keys[k] = `object{${Object.keys(v).length}}`;
    else if (typeof v === 'string') keys[k] = v.length > 64 ? `string[${v.length}]` : `string:${v}`;
    else keys[k] = `${typeof v}:${String(v)}`;
  }
  return { parsed: true, kind: 'object', keys };
}

/** Line and byte counts for a text record that is not JSON. */
export function textShape(text) {
  return { lines: text.split('\n').length, bytes: Buffer.byteLength(text, 'utf8') };
}

const yamlField = (text, name) => text.match(new RegExp(`^${name}:\\s*"?([^"\\n]+)"?`, 'm'))?.[1]?.trim() ?? null;

/**
 * The sources whose version is stamped by the same bump, in one step. The
 * release-sync check requires all of them to equal `package.json`, so they move
 * together or not at all.
 */
export const BUMP_SET = Object.freeze([
  'packageVersion',
  'lockfileVersion',
  'lockfileSelfVersion',
  'claimRegisterVersion',
  'citationVersion',
  'readmeVersion',
]);

/**
 * Version agreement across the sources that name one.
 *
 * The candidate version is the newest dated changelog section, not
 * `package.json`. The stamped sources listed in `BUMP_SET` are written by the
 * release bump in one step, so before that step they all still carry the
 * previously released version. That state is reported as `pending-bump`, for
 * every member at once and only when they agree with each other: a member that
 * has moved while the others have not is a real disagreement, and so is a
 * member on some third version. The documents that carry the candidate version
 * in their own name are held to the candidate directly.
 *
 * The citation date is compared against the changelog entry for the version the
 * citation itself states, not against the candidate's, for the same reason.
 */
export function deriveIdentity(read, has) {
  const changelogText = read('CHANGELOG.md');
  const entry = changelogText == null ? null : newestChangelogEntry(changelogText);
  const candidate = entry?.version ?? null;
  const previous =
    changelogText == null
      ? null
      : (changelogText.match(/^##\s*\[(\d+\.\d+\.\d+(?:-[\w.]+)?)\]/gm) ?? [])
          .map((h) => h.match(/\[([^\]]+)\]/)[1])[1] ?? null;

  const pkgText = read('package.json');
  const pkgVersion = pkgText == null ? null : JSON.parse(pkgText).version;
  const lockText = read('package-lock.json');
  const lock = lockText == null ? null : JSON.parse(lockText);
  const cff = read('CITATION.cff');
  const register = read('docs/validation/claim-register.yaml');
  const readme = read('README.md');

  const stamped = {
    packageVersion: pkgVersion ?? null,
    lockfileVersion: lock?.version ?? null,
    lockfileSelfVersion: lock?.packages?.['']?.version ?? null,
    claimRegisterVersion: register == null ? null : yamlField(register, 'softwareVersion'),
    citationVersion: cff == null ? null : yamlField(cff, 'version'),
    readmeVersion: readme?.match(/current release is \*\*v([^*]+)\*\*/)?.[1] ?? null,
  };
  const stampedValues = BUMP_SET.map((f) => stamped[f]);
  const pendingBump =
    previous != null &&
    candidate != null &&
    previous !== candidate &&
    stampedValues.every((v) => v === previous);

  const fields = [];
  const add = (field, source, value, opts = {}) => {
    const { status, note } = opts;
    if (status) {
      fields.push({ field, source, value, status, note: note ?? null });
      return;
    }
    if (value == null) {
      fields.push({ field, source, value: null, status: 'not-executed', note: note ?? null });
      return;
    }
    fields.push({
      field,
      source,
      value,
      status: value === candidate ? 'agrees' : 'disagrees',
      note: note ?? null,
    });
  };
  const addStamped = (field, source) => {
    const value = stamped[field];
    if (value == null) {
      add(field, source, null);
      return;
    }
    if (pendingBump) {
      add(field, source, value, {
        status: 'pending-bump',
        note: `every stamped source still carries ${previous}; the bump to ${candidate} writes them together`,
      });
      return;
    }
    add(field, source, value);
  };

  add('candidateVersion', 'CHANGELOG.md', candidate);
  addStamped('packageVersion', 'package.json');
  addStamped('lockfileVersion', 'package-lock.json');
  addStamped('lockfileSelfVersion', 'package-lock.json');
  addStamped('claimRegisterVersion', 'docs/validation/claim-register.yaml');
  addStamped('citationVersion', 'CITATION.cff');
  addStamped('readmeVersion', 'README.md');
  add(
    'erratumVersion',
    'docs/release/',
    candidate && has(`docs/release/ERRATUM_v${candidate}.md`) ? candidate : null,
    candidate && has(`docs/release/ERRATUM_v${candidate}.md`) ? {} : { note: 'no erratum collected for the candidate version' },
  );
  add(
    'limitationsVersion',
    'KNOWN_LIMITATIONS_v<version>.md',
    candidate && has(`KNOWN_LIMITATIONS_v${candidate}.md`) ? candidate : null,
    candidate && has(`KNOWN_LIMITATIONS_v${candidate}.md`) ? {} : { note: 'no limitations file collected for the candidate version' },
  );

  const buildMetaPath = candidate ? `release/package-build-metadata-v${candidate}.json` : null;
  const buildMeta = buildMetaPath && has(buildMetaPath) ? JSON.parse(read(buildMetaPath)) : null;
  if (buildMeta == null) {
    add('buildIdentityVersion', buildMetaPath ?? 'release/', null, {
      status: 'not-executed',
      note: 'run `npm run package` to produce the build identity',
    });
    add('archiveName', buildMetaPath ?? 'release/', null, {
      status: 'not-executed',
      note: 'run `npm run package` to produce the archive and its recorded name',
    });
  } else {
    add('buildIdentityVersion', buildMetaPath, buildMeta.version ?? null);
    const name = buildMeta.artifacts?.source?.file ?? null;
    const expected = candidate ? new RegExp(`^openlidarviewer-v${candidate.replace(/\./g, '\\.')}-source-`) : null;
    add('archiveName', buildMetaPath, name, {
      status: name == null ? 'not-executed' : expected.test(name) ? 'agrees' : 'disagrees',
      note: name == null ? 'the build identity records no source archive' : null,
    });
  }

  const citationDate = cff == null ? null : yamlField(cff, 'date-released');
  const citationVersion = stamped.citationVersion;
  const citationEntryDate =
    changelogText == null || citationVersion == null
      ? null
      : changelogText.match(
          new RegExp(`^##\\s*\\[${citationVersion.replace(/\./g, '\\.')}\\]\\s*-\\s*(\\d{4}-\\d{2}-\\d{2})`, 'm'),
        )?.[1] ?? null;
  const dates = {
    citationVersion,
    citationDate,
    changelogDateForCitationVersion: citationEntryDate,
    candidateDate: entry?.date ?? null,
    status:
      citationDate == null || citationEntryDate == null
        ? 'not-executed'
        : citationDate === citationEntryDate
          ? 'agrees'
          : 'disagrees',
  };

  const disagreements = fields.filter((f) => f.status === 'disagrees').map((f) => f.field);
  if (dates.status === 'disagrees') disagreements.push('releaseDate');
  return {
    candidateVersion: candidate,
    previousVersion: previous,
    fields,
    dates,
    disagreements,
    agreement: disagreements.length === 0 ? 'agrees' : 'disagrees',
  };
}

/**
 * The whole snapshot, derived from the collected records.
 *
 * `read(path)` returns the text of a repo-relative collected record or null,
 * `has(path)` says whether it was collected, and `digest(path)` returns its
 * sha256 and byte count. Nothing else is consulted.
 */
export function deriveSnapshot({ read, has, digest, listed }) {
  const inputs = [];
  for (const spec of INPUTS) {
    const paths = new Set(spec.files);
    if (spec.dir) for (const p of listed(spec.dir.path)) if (spec.dir.match.test(p)) paths.add(p);
    const present = [...paths].filter((p) => has(p)).sort();
    const missing = [...paths].filter((p) => !has(p)).sort();
    const status = has(spec.primary) ? 'recorded' : 'not-executed';
    inputs.push({
      id: spec.id,
      title: spec.title,
      status,
      primary: spec.primary,
      producedBy: spec.command,
      files: present.map((p) => {
        const { sha256: hash, bytes } = digest(p);
        const text = read(p);
        return {
          path: p,
          storedAt: evidencePath(spec.id, p),
          sha256: hash,
          bytes,
          shape: p.endsWith('.json') ? jsonShape(text) : textShape(text),
        };
      }),
      missing,
    });
  }

  const registryText = read('validation/defects/defect-registry.json');
  const registry = registryText == null ? null : JSON.parse(registryText);
  const changelog = read('CHANGELOG.md');
  const entry = changelog == null ? null : newestChangelogEntry(changelog);

  let defects = { source: 'validation/defects/defect-registry.json', status: 'not-executed' };
  if (registry != null) {
    const derived = derivedComposition(registry);
    const declared = entry == null ? null : declaredComposition(entry.body);
    const checks = Object.keys(derived).map((k) => ({
      figure: k,
      derived: derived[k],
      declared: declared?.[k] ?? null,
      agrees: declared != null && declared[k] === derived[k],
    }));
    defects = {
      source: 'validation/defects/defect-registry.json',
      status: 'recorded',
      registryVersion: registry.registryVersion,
      derived,
      declared,
      declaredIn: 'CHANGELOG.md',
      checks,
      reconciles: checks.every((c) => c.agrees),
      bySeverity: tally(registry.defects.map((d) => d.severity)),
      byDetectingMechanism: tally(registry.defects.map((d) => d.detectingMechanism)),
      byDiscoveryMethod: tally(registry.defects.map((d) => d.discoveryMethod)),
    };
  }

  const identity = deriveIdentity(read, has);
  const recorded = inputs.filter((i) => i.status === 'recorded').length;
  const failures = [];
  if (defects.status !== 'recorded') failures.push('the defect records were not collected');
  else if (!defects.reconciles) failures.push('the derived defect composition disagrees with the composition the changelog states');
  if (identity.agreement !== 'agrees') failures.push(`identity fields disagree: ${identity.disagreements.join(', ')}`);

  return {
    snapshot: 'validation-snapshot',
    schemaVersion: 1,
    candidateVersion: identity.candidateVersion,
    totals: {
      inputs: inputs.length,
      recorded,
      notExecuted: inputs.length - recorded,
      files: inputs.reduce((n, i) => n + i.files.length, 0),
    },
    defects,
    identity,
    inputs,
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    failures,
  };
}

/** The human-readable summary. Regenerated on every verification. */
export function renderSummary(s) {
  const L = [];
  L.push('# Validation snapshot');
  L.push('');
  L.push(`Candidate version ${s.candidateVersion}. Verdict ${s.verdict}.`);
  L.push('');
  L.push('Nothing below is written by hand.');
  L.push('');
  L.push(
    'Every figure comes from the records stored under `evidence/`, computed by ' +
      '`scripts/validation-snapshot-lib.mjs` and recomputed from the same bytes each time the ' +
      'snapshot is checked. An input that was not produced is recorded as not executed, with ' +
      'the command that produces it. It is never a zero and never a pass.',
  );
  L.push('');
  if (s.failures.length > 0) {
    L.push('## Why this snapshot fails');
    L.push('');
    for (const f of s.failures) L.push(`- ${f}`);
    L.push('');
  }
  L.push('## Defect composition');
  L.push('');
  if (s.defects.status !== 'recorded') {
    L.push('The defect records were not collected.');
  } else {
    L.push(
      `Registry version ${s.defects.registryVersion}. The figures on the left are counted over the ` +
        `records themselves, one record at a time. The figures beside them are the ones ` +
        `\`${s.defects.declaredIn}\` states in prose for this version, read back out of that text. ` +
        'Neither column is copied from the other, so a record set and the sentence that describes ' +
        'it cannot drift apart without one of these rows disagreeing, and a row that disagrees ' +
        'fails the snapshot rather than being reconciled by editing the records.',
    );
    L.push('');
    L.push('| figure | derived | stated | agrees |');
    L.push('| --- | --- | --- | --- |');
    for (const c of s.defects.checks) {
      L.push(`| ${c.figure} | ${c.derived} | ${c.declared ?? 'not stated'} | ${c.agrees ? 'yes' : 'no'} |`);
    }
    L.push('');
    L.push(`Reconciles: ${s.defects.reconciles ? 'yes' : 'no'}.`);
    L.push('');
    const table = (heading, counts) => {
      L.push(`| ${heading} | records |`);
      L.push('| --- | --- |');
      for (const [k, v] of Object.entries(counts)) L.push(`| ${k} | ${v} |`);
      L.push('');
    };
    table('severity', s.defects.bySeverity);
    table('discovery method', s.defects.byDiscoveryMethod);
    table('detecting mechanism', s.defects.byDetectingMechanism);
  }
  L.push('## Identity');
  L.push('');
  L.push(`Agreement: ${s.identity.agreement}.`);
  L.push('');
  L.push('| field | source | value | status | note |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const f of s.identity.fields) {
    L.push(`| ${f.field} | \`${f.source}\` | ${f.value ?? 'none'} | ${f.status} | ${f.note ?? ''} |`);
  }
  L.push('');
  L.push(
    `Release date: the citation states ${s.identity.dates.citationDate ?? 'none'} for version ` +
      `${s.identity.dates.citationVersion ?? 'none'}, the changelog entry for that version states ` +
      `${s.identity.dates.changelogDateForCitationVersion ?? 'none'} (${s.identity.dates.status}). ` +
      `The candidate entry is dated ${s.identity.dates.candidateDate ?? 'none'}.`,
  );
  L.push('');
  L.push('## Inputs');
  L.push('');
  L.push(`${s.totals.recorded} of ${s.totals.inputs} collected, ${s.totals.notExecuted} not executed, over ${s.totals.files} records.`);
  L.push('');
  L.push('| input | status | records | produced by |');
  L.push('| --- | --- | --- | --- |');
  for (const i of s.inputs) {
    L.push(`| ${i.title} | ${i.status} | ${i.files.length} | \`${i.producedBy}\` |`);
  }
  L.push('');
  const notRun = s.inputs.filter((i) => i.status === 'not-executed');
  if (notRun.length > 0) {
    L.push('## Not executed');
    L.push('');
    L.push('Each of these is absent. Absent is not empty, and it is not passing. The command beside it is what produces the record, and until that runs there is nothing here to report.');
    L.push('');
    for (const i of notRun) L.push(`- ${i.title}: \`${i.primary}\` is absent. Run \`${i.producedBy}\`.`);
    L.push('');
  }
  L.push('## Records');
  L.push('');
  L.push('| record | bytes | sha256 |');
  L.push('| --- | --- | --- |');
  for (const i of s.inputs) {
    for (const f of i.files) L.push(`| \`${f.path}\` | ${f.bytes} | \`${f.sha256}\` |`);
  }
  L.push('');
  L.push('## Scope');
  L.push('');
  L.push('This snapshot states what was collected and what was not.');
  L.push('');
  L.push(
    'It does not state that the collected records cover the software. It says nothing about ' +
      'agreement with field measurement. Each record carries its own scope, written by whoever ' +
      'produced it, and that is where the limits of the record are stated.',
  );
  L.push('');
  L.push('Read them there.');
  return `${L.join('\n')}\n`;
}
