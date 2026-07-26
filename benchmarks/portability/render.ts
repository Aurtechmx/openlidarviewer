/**
 * render.ts
 *
 * `comparison.csv` and `summary.md`, both derived from `comparison.json` and
 * from nothing else.
 *
 * WHY THE DERIVATION IS TOTAL. The Markdown is the file a reader quotes and the
 * CSV is the file a plot reads, and neither is worth anything if it can drift
 * from the JSON beside it. Every function here takes the comparison document as
 * its only argument, so there is no second source a number could come from, and
 * the verifier re-renders both and compares byte for byte. That is the same
 * arrangement `benchmark:verify` already makes for the per-suite reports.
 *
 * Pure. No I/O, no clock.
 */

import { csvRow } from '../framework';
import type { PortabilityComparison } from './compare';
import type { PlatformRecord } from './record';

const CSV_HEADER = 'section,field,kind,verdict,platform,value';

/**
 * Long format, one row per platform per field.
 *
 * A wide table with one column per platform would have to be reshaped every
 * time a leg is added or dropped, and a two-platform file and a three-platform
 * file would not share a column set. Long format keeps every result set
 * readable by the same reader.
 */
export function comparisonCsv(comparison: PortabilityComparison): string {
  const lines: string[] = [CSV_HEADER];

  lines.push(csvRow(['status', 'status', 'comparison', comparison.status, '', comparison.status]));
  lines.push(
    csvRow([
      'status',
      'claimEstablished',
      'comparison',
      comparison.claimEstablished ? 'established' : 'not-established',
      '',
      String(comparison.claimEstablished),
    ]),
  );
  for (const [platform, order] of Object.entries(comparison.endianness)) {
    lines.push(csvRow(['precondition', 'endianness', 'host', 'recorded', platform, order]));
  }
  for (const [i, failure] of comparison.preconditionFailures.entries()) {
    lines.push(csvRow(['precondition', `failure[${i}]`, 'blocking', 'failed', '', failure]));
  }

  for (const [platform, hash] of Object.entries(comparison.fixture.sourceCloudHashes)) {
    lines.push(
      csvRow([
        'fixture',
        'sourceCloudHash',
        'sha256',
        comparison.fixture.identical ? 'identical' : 'differs',
        platform,
        hash ?? 'absent',
      ]),
    );
  }
  for (const [platform, hash] of Object.entries(comparison.fixture.descriptorHashes)) {
    lines.push(
      csvRow([
        'fixture',
        'descriptorHash',
        'sha256',
        comparison.fixture.identical ? 'identical' : 'differs',
        platform,
        hash ?? 'absent',
      ]),
    );
  }
  for (const mismatch of comparison.fixture.mismatches) {
    for (const [platform, value] of Object.entries(mismatch.values)) {
      lines.push(csvRow(['fixture', mismatch.field, mismatch.kind, 'mismatch', platform, value]));
    }
  }

  lines.push(
    csvRow(['science', 'hashesCompared', 'count', comparison.science.evaluated ? 'evaluated' : 'suppressed', '', String(comparison.science.hashesCompared)]),
    csvRow(['science', 'hashesMismatched', 'count', comparison.science.evaluated ? 'evaluated' : 'suppressed', '', String(comparison.science.hashesMismatched)]),
    csvRow(['science', 'scalarsCompared', 'count', comparison.science.evaluated ? 'evaluated' : 'suppressed', '', String(comparison.science.scalarsCompared)]),
    csvRow(['science', 'scalarsMismatched', 'count', comparison.science.evaluated ? 'evaluated' : 'suppressed', '', String(comparison.science.scalarsMismatched)]),
  );
  if (comparison.science.suppressedReason !== null) {
    lines.push(csvRow(['science', 'suppressedReason', 'note', 'suppressed', '', comparison.science.suppressedReason]));
  }
  for (const mismatch of comparison.science.mismatches) {
    for (const [platform, value] of Object.entries(mismatch.values)) {
      lines.push(csvRow(['science', mismatch.field, mismatch.kind, 'mismatch', platform, value]));
    }
  }

  for (const difference of comparison.expectedDifferences) {
    for (const [platform, value] of Object.entries(difference.values)) {
      lines.push(csvRow(['expected-difference', difference.field, difference.category, 'expected', platform, value]));
    }
  }
  for (const exclusion of comparison.structuralExclusions) {
    lines.push(csvRow(['expected-difference', exclusion.field, 'structural', 'not-compared', '', exclusion.why]));
  }

  for (const row of comparison.timing) {
    lines.push(
      csvRow([
        'timing',
        'medianAnalysisMs',
        'ms',
        row.medianAnalysisMs === null ? 'unavailable' : 'measured',
        row.platformId,
        row.medianAnalysisMs === null ? (row.medianAnalysisUnavailableReason ?? 'unavailable') : String(row.medianAnalysisMs),
      ]),
      csvRow([
        'timing',
        'analysisCv',
        'ratio',
        row.analysisCv === null ? 'unavailable' : 'measured',
        row.platformId,
        row.analysisCv === null ? (row.analysisCvUnavailableReason ?? 'unavailable') : String(row.analysisCv),
      ]),
      csvRow([
        'timing',
        'peakRssBytes',
        'bytes',
        row.peakRssBytes === null ? 'unavailable' : 'measured',
        row.platformId,
        row.peakRssBytes === null ? (row.peakRssUnavailableReason ?? 'unavailable') : String(row.peakRssBytes),
      ]),
      csvRow(['timing', 'recordedRuns', 'count', 'measured', row.platformId, String(row.recordedRuns)]),
    );
  }

  return `${lines.join('\n')}\n`;
}

/** A cell that never reads as a measurement when there is no measurement. */
function numberCell(value: number | null, reason: string | null, format: (n: number) => string): string {
  return value === null ? `unavailable (${reason ?? 'no reason recorded'})` : format(value);
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function comparisonMarkdown(comparison: PortabilityComparison): string {
  const out: string[] = [];
  out.push('# Cross-platform scientific reproducibility');
  out.push('');
  out.push(`Status: **${comparison.status}**`);
  out.push('');
  out.push(comparison.claim);
  out.push('');
  out.push('## What was evaluated');
  out.push('');
  out.push('| Field | Value |');
  out.push('| --- | --- |');
  out.push(`| Platforms | ${comparison.platforms.join(', ')} |`);
  out.push(`| Commit | ${comparison.evaluatedCommit ?? 'not agreed across platforms'} |`);
  out.push(`| Release version | ${comparison.releaseVersion} |`);
  out.push(`| Lockfile sha256 | ${comparison.lockfileSha256 ?? 'not agreed across platforms'} |`);
  out.push(`| Fixture seed | ${comparison.fixture.seed === null ? 'unavailable' : String(comparison.fixture.seed)} |`);
  out.push(
    `| Fixture points | ${comparison.fixture.requestedPointCount === null ? 'unavailable' : String(comparison.fixture.requestedPointCount)} requested, ${comparison.fixture.generatedPointCount === null ? 'unavailable' : String(comparison.fixture.generatedPointCount)} generated |`,
  );
  out.push(`| Dataset | ${comparison.fixture.datasetId ?? 'unavailable'} |`);
  out.push(`| Scalar tolerance | ${comparison.scalarTolerance} |`);
  out.push(
    `| Byte order | ${Object.entries(comparison.endianness).map(([id, e]) => `${id} ${e}`).join(', ')} |`,
  );
  out.push('');

  if (comparison.preconditionFailures.length > 0) {
    out.push('## Preconditions that did not hold');
    out.push('');
    out.push('The legs are not comparable until every line below is resolved.');
    out.push('');
    for (const failure of comparison.preconditionFailures) out.push(`- ${failure}`);
    out.push('');
  }

  out.push('## The seeded fixture, compared first');
  out.push('');
  // Worded off the platform COUNT, not only off the verdict. With one leg
  // "identical on every platform" is true and empty at the same time, and a
  // sentence a reader can take for a cross-platform result is the one thing a
  // single-platform report must not contain.
  out.push(
    comparison.platforms.length < 2
      ? 'One platform was recorded, so the source cloud below has nothing to be compared against. It is published as the reference a second platform will be checked against.'
      : comparison.fixture.identical
        ? 'The seeded source cloud is byte-identical on every platform, so any downstream difference would be a property of the analysis rather than of its input.'
        : 'The seeded source cloud differs between platforms. Every downstream artifact differs as a consequence, so the downstream comparison is suppressed and the finding stands against the generator rather than against the analysis pipeline.',
  );
  out.push('');
  out.push('| Platform | Source cloud sha256 | Fixture descriptor sha256 |');
  out.push('| --- | --- | --- |');
  for (const platform of comparison.platforms) {
    out.push(
      `| ${platform} | ${comparison.fixture.sourceCloudHashes[platform] ?? 'absent'} | ${comparison.fixture.descriptorHashes[platform] ?? 'absent'} |`,
    );
  }
  out.push('');
  if (comparison.fixture.likelyCause !== null) {
    out.push(`Where to look first: ${comparison.fixture.likelyCause}`);
    out.push('');
  }
  for (const mismatch of comparison.fixture.mismatches) {
    out.push(
      `- ${mismatch.field} (${mismatch.kind}): ${Object.entries(mismatch.values).map(([id, v]) => `${id}=${v}`).join(', ')}`,
    );
  }
  if (comparison.fixture.mismatches.length > 0) out.push('');

  out.push('## Science-scoped outputs');
  out.push('');
  if (!comparison.science.evaluated) {
    out.push(`Not evaluated: ${comparison.science.suppressedReason ?? 'no reason recorded'}`);
    out.push('');
  } else {
    // With one leg there is no second value for anything to be compared
    // against, and a sentence saying N hashes "were compared" would read as a
    // comparison that happened. The counts are still worth publishing: they are
    // what a second platform will be checked against.
    out.push(
      comparison.platforms.length < 2
        ? `${comparison.science.hashesCompared} artifact hashes and ${comparison.science.scalarsCompared} scalar values are recorded on the single platform above. Nothing was compared against them.`
        : `${comparison.science.hashesCompared} artifact hashes and ${comparison.science.scalarsCompared} scalar values were compared at a tolerance of exactly zero. ${comparison.science.hashesMismatched} hashes and ${comparison.science.scalarsMismatched} scalars differ.`,
    );
    out.push('');
    if (comparison.science.mismatches.length > 0) {
      out.push('| Field | Kind | Values |');
      out.push('| --- | --- | --- |');
      for (const mismatch of comparison.science.mismatches) {
        out.push(
          `| ${mismatch.field} | ${mismatch.kind} | ${Object.entries(mismatch.values).map(([id, v]) => `${id}=${v}`).join('<br>')} |`,
        );
      }
      out.push('');
    }
  }

  out.push('## Differences that are expected');
  out.push('');
  out.push('Each one is published with the value every platform reported. None of them gates the result.');
  out.push('');
  if (comparison.expectedDifferences.length === 0) {
    out.push('No expected difference was observed between these platforms.');
    out.push('');
  } else {
    out.push('| Category | Field | Values | Why it may differ |');
    out.push('| --- | --- | --- | --- |');
    for (const difference of comparison.expectedDifferences) {
      out.push(
        `| ${difference.category} | ${difference.field} | ${Object.entries(difference.values).map(([id, v]) => `${id}=${v}`).join('<br>')} | ${difference.why} |`,
      );
    }
    out.push('');
  }
  out.push('Excluded from the comparison by construction:');
  out.push('');
  for (const exclusion of comparison.structuralExclusions) {
    out.push(`- ${exclusion.field}: ${exclusion.why}`);
  }
  out.push('');

  out.push('## Runtime, per platform');
  out.push('');
  out.push(
    'Runtimes are not pooled. A median over two machines describes neither of them, and the result this suite reports is output identity rather than which host is faster.',
  );
  out.push('');
  out.push('| Platform | Recorded runs | Median analysis | Analysis CV | Peak RSS |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const row of comparison.timing) {
    out.push(
      `| ${row.platformId} | ${row.recordedRuns} | ${numberCell(row.medianAnalysisMs, row.medianAnalysisUnavailableReason, (n) => `${n.toFixed(1)} ms`)} | ${numberCell(row.analysisCv, row.analysisCvUnavailableReason, (n) => n.toFixed(4))} | ${numberCell(row.peakRssBytes, row.peakRssUnavailableReason, mib)} |`,
    );
  }
  out.push('');

  out.push('## Scope');
  out.push('');
  out.push(
    `This result covers ${comparison.platforms.join(' and ')} on the Node major version the workflow pins, at the commit above. It is not a claim of platform independence: untested platforms, other runtime versions and big-endian hosts are outside it. Windows is not covered.`,
  );
  out.push('');

  return out.join('\n');
}

/**
 * The environment document, one entry per platform.
 *
 * Separate from the comparison so a reader can answer "what were these two
 * machines" without reading a comparison, and so the comparison stays about
 * agreement rather than about hosts.
 */
export function environmentsDocument(records: readonly PlatformRecord[]): unknown {
  return {
    note: 'Full environment of every platform leg. Every field here is allowed to differ between platforms; the comparison lists the ones that actually did.',
    platforms: [...records]
      .sort((a, b) => (a.platformId < b.platformId ? -1 : 1))
      .map((r) => ({
        platformId: r.platformId,
        environment: r.environment,
        evaluated: r.evaluated,
        internal: r.internal,
        timing: r.timing,
      })),
  };
}
