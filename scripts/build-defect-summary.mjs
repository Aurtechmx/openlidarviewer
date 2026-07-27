#!/usr/bin/env node
/**
 * Generate the defect summaries from validation/defects/defect-registry.json.
 *
 *   node scripts/build-defect-summary.mjs          write the three summaries
 *   node scripts/build-defect-summary.mjs --check  fail if they are stale
 *
 * Every count in defect-summary.{json,csv,md} comes from this script. Nothing
 * in those files is written by hand, and re-running it on an unchanged registry
 * reproduces them byte for byte. Exit 0 on success, 1 on a stale check, 2 on a
 * read or parse error.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/defects');
const REGISTRY = resolve(DIR, 'defect-registry.json');

/**
 * The taxonomy carries two kinds of term. One names what the code did wrong,
 * the other names why the existing checks did not see it. A defect can carry
 * both, so the two tables are counted over the primary category and the
 * secondary tags together and a defect may appear in each table once.
 */
const TERM_KIND = new Map([
  ['unit-conversion divergence', 'failure mechanism'],
  ['coordinate-frame or axis error', 'failure mechanism'],
  ['metadata asymmetry', 'failure mechanism'],
  ['read/write round-trip loss', 'failure mechanism'],
  ['fabricated quantity', 'failure mechanism'],
  ['unavailable-state handling', 'failure mechanism'],
  ['identity collision', 'failure mechanism'],
  ['provenance failure', 'failure mechanism'],
  ['archive or release-artifact failure', 'failure mechanism'],
  ['unsupported claim or wording', 'failure mechanism'],
  ['execution or reachability gap', 'detection gap'],
  ['oracle gap', 'detection gap'],
  ['fixture inadequacy', 'detection gap'],
  ['verification blind spot', 'detection gap'],
  ['environment mismatch', 'detection gap'],
]);

let registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
} catch (err) {
  console.error(`cannot read the registry: ${err.message}`);
  process.exit(2);
}
const defects = registry.defects;

/** Count into a plain map, sorted by count then by key, so output is stable. */
function tally(pairs) {
  const counts = new Map();
  for (const key of pairs) counts.set(key, (counts.get(key) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
  );
}

const termsOf = (d) => [d.validationCategory, ...d.secondaryTags];
const kindTally = (kind) =>
  tally(
    defects.flatMap((d) => {
      const hit = termsOf(d).filter((t) => TERM_KIND.get(t) === kind);
      return [...new Set(hit)];
    }),
  );

const suiteDetected = defects.filter((d) => d.detectingMechanism !== 'none');
const otherwiseDiscovered = defects.filter((d) => d.detectingMechanism === 'none');
const withSecondary = defects.filter((d) => d.secondaryTags.length > 0);
const suiteGreen = defects.filter((d) => d.conventionalSuiteAtV061 === 'green');
const noPreexistingTests = defects.filter((d) => d.preexistingTests.length === 0);
const withMagnitude = defects.filter((d) => d.magnitude !== null);

const summary = {
  generatedBy: 'scripts/build-defect-summary.mjs',
  source: 'validation/defects/defect-registry.json',
  registryVersion: registry.registryVersion,
  recordGranularity: registry.recordGranularity,
  totals: {
    defects: defects.length,
    detectedByAValidationSuite: suiteDetected.length,
    discoveredWithoutAValidationSuite: otherwiseDiscovered.length,
    missedByTestsThatAlreadyExisted: defects.length,
    withNoPreexistingTestReferencingTheModule: noPreexistingTests.length,
    withAMeasuredMagnitude: withMagnitude.length,
    withoutAMeasuredMagnitude: defects.length - withMagnitude.length,
    needingASecondaryTag: withSecondary.length,
    needingNoSecondaryTag: defects.length - withSecondary.length,
  },
  conventionalSuiteAtV061: {
    definition: registry.conventionalSuiteDefinition.meaning,
    howEstablished: registry.conventionalSuiteDefinition.howEstablished,
    result: registry.conventionalSuiteDefinition.result,
    note: registry.conventionalSuiteDefinition.note,
    counts: tally(defects.map((d) => d.conventionalSuiteAtV061)),
    greenOnDefectiveCode: suiteGreen.length,
  },
  byValidationCategory: tally(defects.map((d) => d.validationCategory)),
  byFailureMechanism: kindTally('failure mechanism'),
  byDetectionGap: kindTally('detection gap'),
  bySeverity: tally(defects.map((d) => d.severity)),
  byDetectingMechanism: tally(defects.map((d) => d.detectingMechanism)),
  byDiscoveryMethod: tally(defects.map((d) => d.discoveryMethod)),
  byOracleType: tally(defects.map((d) => d.oracleType)),
  byFixPr: tally(defects.map((d) => `PR #${d.fixPr}`)),
  index: defects.map((d) => ({
    id: d.id,
    name: d.name,
    severity: d.severity,
    validationCategory: d.validationCategory,
    secondaryTags: d.secondaryTags,
    detectingMechanism: d.detectingMechanism,
    discoveryMethod: d.discoveryMethod,
    conventionalSuiteAtV061: d.conventionalSuiteAtV061,
    regressionTestFile: d.regressionTest.file,
    fixCommit: d.fixCommit,
    fixPr: d.fixPr,
  })),
};

const CSV_COLUMNS = [
  'id', 'name', 'affectedVersion', 'module', 'codePath', 'severity',
  'magnitude', 'validationCategory', 'secondaryTags', 'detectingMechanism',
  'discoveryMethod', 'oracleType', 'conventionalSuiteAtV061',
  'preexistingTestCount', 'regressionTestFile', 'regressionTestCaseCount',
  'fixCommit', 'fixPr', 'verificationStatus',
];

const csvCell = (v) => {
  const s = v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  return /["\n,]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

const csv = [
  CSV_COLUMNS.join(','),
  ...defects.map((d) =>
    CSV_COLUMNS.map((c) =>
      csvCell(
        c === 'preexistingTestCount' ? d.preexistingTests.length
          : c === 'regressionTestFile' ? d.regressionTest.file
          : c === 'regressionTestCaseCount' ? d.regressionTest.cases.length
          : d[c],
      ),
    ).join(','),
  ),
].join('\n') + '\n';

/** A GitHub-flavoured table from a count map. */
function countTable(heading, counts, unit = 'defects') {
  const rows = Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`);
  return [`| ${heading} | ${unit} |`, '| --- | --- |', ...rows].join('\n');
}

const SUITE_LABEL = {
  'none': 'no suite (code review)',
  'suite-2-unit-integrity': 'unit integrity',
  'suite-4-failure-recovery': 'failure recovery',
  'suite-5-provenance-integrity': 'provenance integrity',
  'suite-6-contour-correctness': 'contour correctness',
  'suite-7-las-round-trip': 'LAS round trip',
  'suite-8-archive-portability': 'archive portability',
};

/** Defect to evidence: what exposed each record, and what holds it fixed. */
function mermaid() {
  const lines = ['```mermaid', 'flowchart LR'];
  const mechanisms = [...new Set(defects.map((d) => d.detectingMechanism))].sort();
  const files = [...new Set(defects.map((d) => d.regressionTest.file))].sort();
  const mId = (m) => `M_${m.replaceAll('-', '_')}`;
  const fId = (f) => `F_${f.replaceAll(/[^A-Za-z0-9]/g, '_')}`;
  for (const m of mechanisms) {
    lines.push(`  ${mId(m)}["${SUITE_LABEL[m] ?? m}"]`);
  }
  for (const d of defects) {
    lines.push(`  ${d.id.replaceAll('-', '_')}["${d.id}<br/>${d.validationCategory}"]`);
  }
  for (const f of files) {
    lines.push(`  ${fId(f)}["${f}"]`);
  }
  for (const d of defects) {
    const n = d.id.replaceAll('-', '_');
    lines.push(`  ${mId(d.detectingMechanism)} --> ${n}`);
    lines.push(`  ${n} --> ${fId(d.regressionTest.file)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

const md = `# Defect summary

Generated by \`scripts/build-defect-summary.mjs\` from
\`validation/defects/defect-registry.json\`. Do not edit this file; edit the
registry and re-run the script. Every number below is a count over the
registry records, and ${registry.recordGranularity.charAt(0).toLowerCase()}${registry.recordGranularity.slice(1)}

Records: ${defects.length}. Registry version ${registry.registryVersion}.

## Detection

${countTable('detecting mechanism', summary.byDetectingMechanism)}

${countTable('discovery method', summary.byDiscoveryMethod)}

Detected by a validation suite: ${summary.totals.detectedByAValidationSuite} of ${defects.length}. Discovered without one: ${summary.totals.discoveredWithoutAValidationSuite} of ${defects.length}. The
second group came from reading the code, and \`scripts/check-defect-registry.mjs\`
refuses a record whose \`discoveryMethod\` and \`detectingMechanism\` disagree, so
the two figures cannot drift apart.

## The suite that already existed

${registry.conventionalSuiteDefinition.meaning}

Established by: ${registry.conventionalSuiteDefinition.howEstablished}
Result: ${registry.conventionalSuiteDefinition.result}, measured ${registry.conventionalSuiteDefinition.measuredOn}.

${countTable('state on the defective code', summary.conventionalSuiteAtV061.counts)}

${registry.conventionalSuiteDefinition.note}

All ${summary.totals.missedByTestsThatAlreadyExisted} records were missed by the tests that already existed, which is what
placed them in this registry. ${summary.totals.withNoPreexistingTestReferencingTheModule} had no pre-existing test file referencing the
affected module at all.

## Taxonomy

${countTable('primary validation category', summary.byValidationCategory)}

Counted over the primary category and the secondary tags together, once per record:

${countTable('failure mechanism', summary.byFailureMechanism)}

${countTable('detection gap', summary.byDetectionGap)}

Records carrying at least one secondary tag: ${summary.totals.needingASecondaryTag} of ${defects.length}. A record needs one when a
single term does not cover it, most often because a unit or frame fault sat
behind a check that could not reach it.

## Severity

${countTable('severity', summary.bySeverity)}

- high: ${registry.severityScale.high}
- medium: ${registry.severityScale.medium}
- low: ${registry.severityScale.low}

Records with a measured magnitude: ${summary.totals.withAMeasuredMagnitude}. Without one: ${summary.totals.withoutAMeasuredMagnitude}, recorded as null rather than as zero.

## Oracle required

${countTable('oracle type', summary.byOracleType)}

## Where the fixes landed

${countTable('pull request', summary.byFixPr)}

## Defect to evidence

Left to right: what exposed the record, the record, and the test that holds it
fixed. The left column is the \`detectingMechanism\` field, so a record found by
reading the code enters the diagram from the "no suite" node rather than from a
suite. The right column is the \`regressionTest.file\` field verbatim. Records
sharing a test file converge on one node, which is why some nodes carry several
edges. Nothing in the diagram is weighted, ordered by importance, or scaled by
severity; it is an adjacency drawing of two registry fields, regenerated with
the rest of this file.

${mermaid()}

## Index

| id | severity | category | detected by | regression test |
| --- | --- | --- | --- | --- |
${summary.index.map((d) => `| ${d.id} | ${d.severity} | ${d.validationCategory} | ${SUITE_LABEL[d.detectingMechanism] ?? d.detectingMechanism} | \`${d.regressionTestFile}\` |`).join('\n')}
`;

const outputs = [
  ['defect-summary.json', JSON.stringify(summary, null, 2) + '\n'],
  ['defect-summary.csv', csv],
  ['defect-summary.md', md],
];

const check = process.argv.includes('--check');
let stale = 0;
mkdirSync(DIR, { recursive: true });
for (const [name, content] of outputs) {
  const path = resolve(DIR, name);
  if (check) {
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      current = null;
    }
    if (current !== content) {
      console.error(`stale: ${name} does not match the registry`);
      stale += 1;
    }
  } else {
    writeFileSync(path, content);
    console.log(`wrote validation/defects/${name}`);
  }
}

if (check) {
  if (stale > 0) process.exit(1);
  console.log(`defect summaries are current for ${defects.length} records`);
}
