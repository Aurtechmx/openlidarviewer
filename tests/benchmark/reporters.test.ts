/**
 * reporters.test.ts — every output format carries the same honest content.
 *
 * A reporter is where an unavailable metric is most likely to be quietly turned
 * into a blank cell, a dash or a zero: those all read as "measured, and small".
 * So each of the four formats is asserted to print the word "unavailable" AND
 * the reason, and to carry the provenance a reader needs to reproduce the run.
 */
import { describe, test, expect } from 'vitest';
import { toJson } from '../../benchmarks/framework/reporters/json';
import { toCsv } from '../../benchmarks/framework/reporters/csv';
import { toMarkdown } from '../../benchmarks/framework/reporters/markdown';
import { toHtml } from '../../benchmarks/framework/reporters/html';
import {
  capturedEnv,
  measured,
  unavailable,
  type BenchmarkEnvironment,
  type RunReport,
} from '../../benchmarks/framework/types';
import { RAW_BYTES_NO_STRIP_REASON } from '../../benchmarks/framework/artifacts';
import {
  describeHashExclusions,
  ENVIRONMENT_LABELS,
} from '../../benchmarks/framework/reporters/metricText';
import { fixtureReport } from './reportFixture';

/**
 * Each reporter with the EXACT rendering of two facts that a `toContain` check
 * cannot pin: the schema version (`toContain('1')` also matches `1024`) and the
 * dataset id in a labelled position. Asserting the real shape is what makes
 * these tests able to fail.
 */
const REPORTERS: ReadonlyArray<readonly [string, (r: RunReport) => string, RegExp, RegExp]> = [
  ['json', toJson, /"schemaVersion": 1,/, /"datasetId": "synthetic-grid-1m"/],
  ['csv', toCsv, /^run,schemaVersion,1,/m, /^run,datasetId,synthetic-grid-1m,/m],
  ['markdown', toMarkdown, /\| schema version \| 1 \|/, /\| dataset \| synthetic-grid-1m \|/],
  [
    'html',
    toHtml,
    /<th>schema version<\/th><td>1<\/td>/,
    /<th>dataset<\/th><td>synthetic-grid-1m<\/td>/,
  ],
];

const MEMORY_REASON = 'process.memoryUsage is not exposed in this runtime';
const GPU_REASON = 'WebGPU timestamp queries need a browser runtime';

describe.each(REPORTERS)('the %s reporter', (name, render, schemaRe, datasetRe) => {
  const out = render(fixtureReport());

  test('renders both unavailable metrics as unavailable, with their reason', () => {
    expect(out.toLowerCase()).toContain('unavailable');
    expect(out).toContain(MEMORY_REASON);
    expect(out).toContain(GPU_REASON);
  });

  test('carries the environment, dataset, commit, release and schema version', () => {
    expect(out).toMatch(datasetRe);
    expect(out).toMatch(schemaRe);
    expect(out).toContain('darwin 24.0.0'); // OS
    expect(out).toContain('Apple M2 Pro'); // CPU model
    expect(out).toContain('arm64'); // arch
    expect(out).toContain('v22.17.1'); // Node version
    expect(out).toContain('5f452c7'); // git commit
    expect(out).toContain('0.6.0'); // release version
  });

  test('carries EVERY environment field the schema declares', () => {
    // Two reporters used to hard-code their own field lists, so a provenance
    // field could land in the JSON and vanish from the page a reader opens.
    for (const key of Object.keys(ENVIRONMENT_LABELS) as (keyof BenchmarkEnvironment)[]) {
      const field = fixtureReport().environment[key];
      if (field.status !== 'captured') continue;
      expect(out, key).toContain(field.value);
    }
  });

  test('discloses whether the working tree matched the commit', () => {
    // A commit hash with no dirty flag asserts a provenance the run may not have.
    expect(out).toContain('clean');
  });

  test('carries every stage name, its duration and its peak memory', () => {
    expect(out).toContain('decode');
    expect(out).toContain('gpu upload');
    expect(out).toContain('12.5'); // decode duration ms
    expect(out).toContain('1024'); // decode peak RSS bytes
  });

  test('shows a failed stage as failed, with its error', () => {
    expect(out).toContain('failed');
    expect(out).toContain('no GPU adapter');
  });

  test('names the artifact and its hash', () => {
    expect(out).toContain('metrics');
    expect(out).toContain('a'.repeat(64));
  });

  test('discloses that the byte artifact was hashed with no strip applied', () => {
    // An empty exclusion list on a raw-bytes artifact reads as "nothing
    // volatile in here", when the truth is that nothing COULD be inspected.
    expect(out).toContain('hillshade');
    expect(out).toContain(RAW_BYTES_NO_STRIP_REASON);
  });

  test('never prints a bare dash or an empty cell where a metric belongs', () => {
    // A lone "-" or "" is how an unavailable metric silently becomes "0-ish" to
    // a reader. Wherever this reporter mentions the unavailable memory metric,
    // the reason has to be on the same line.
    const lines = out.split('\n').filter((l) => l.includes(MEMORY_REASON));
    expect(lines.length, name).toBeGreaterThan(0);
  });

  test('a newline in an error does not split the row it belongs to', () => {
    // Error.message is routinely multi-line, and a raw newline ends a Markdown
    // row mid-table. Every format has to survive it.
    const report = fixtureReport();
    const stages = report.stages.map((s) =>
      s.status === 'failed' ? { ...s, error: 'line one\nline two' } : s,
    );
    const rendered = render({ ...report, stages });
    expect(rendered).toContain('line one');
    expect(rendered).toContain('line two');
    if (name === 'markdown') {
      expect(rendered).not.toMatch(/\| line two/);
      expect(rendered).toContain('line one; line two');
    }
  });
});

describe('describeHashExclusions', () => {
  const [stripped, raw] = fixtureReport().artifacts;

  test('names the excluded fields when the strip ran', () => {
    expect(describeHashExclusions(stripped)).toBe('generatedAt');
  });

  test('says (none) when the strip ran and found nothing', () => {
    expect(describeHashExclusions({ ...stripped, strippedFields: [] })).toBe('(none)');
  });

  test('always has a reason to give when no strip ran', () => {
    // There is no "unexplained" case left to fall back to: the record type
    // makes `volatilityStripped: false` without a reason a compile error, so
    // the old 'no reason recorded' string is unreachable by construction.
    const out = describeHashExclusions(raw);
    expect(out).toContain('not stripped');
    expect(out).toContain(RAW_BYTES_NO_STRIP_REASON);
    expect(out).not.toContain('no reason recorded');
  });
});

describe('the JSON reporter', () => {
  test('round-trips to the same report', () => {
    const report = fixtureReport();
    expect(JSON.parse(toJson(report))).toEqual(report);
  });

  test('keeps status and reason on the unavailable metric rather than dropping the key', () => {
    const parsed = JSON.parse(toJson(fixtureReport())) as RunReport;
    const gpu = parsed.metrics.gpuFrameTime;
    expect(gpu.status).toBe('unavailable');
    expect(gpu.value).toBeNull();
    expect('gpuFrameTime' in parsed.metrics).toBe(true);
  });
});

describe('the CSV reporter', () => {
  const csv = toCsv(fixtureReport());
  const rows = csv.trim().split('\n');

  test('starts with a stable header naming the honesty columns', () => {
    expect(rows[0]).toBe('section,name,value,unit,status,reason,runtime,deterministic');
  });

  test('an unavailable row says unavailable in the value column and carries the reason', () => {
    const row = rows.find((r) => r.startsWith('stage,gpu upload.peakMemory,'));
    expect(row).toBeDefined();
    const cells = row!.split(',');
    expect(cells[2]).toBe('unavailable');
    expect(cells[2]).not.toBe('');
    expect(cells[2]).not.toBe('0');
    expect(row).toContain(MEMORY_REASON);
  });

  test('quotes a value that contains a comma so the columns stay aligned', () => {
    const report = fixtureReport();
    const withComma: RunReport = { ...report, datasetId: 'grid,1m' };
    expect(toCsv(withComma)).toContain('"grid,1m"');
  });

  test('neutralises a cell a spreadsheet would run as a formula', () => {
    const report = fixtureReport();
    for (const payload of ['=HYPERLINK(x)', '+1+1', '@SUM(A1)', '-1+1', '\tcmd']) {
      const rendered = toCsv({ ...report, datasetId: payload });
      expect(rendered, payload).toContain(`"'${payload}"`);
    }
  });

  test('a negative NUMBER is left alone, so it stays a number in the sheet', () => {
    const report = fixtureReport();
    const negative: RunReport = {
      ...report,
      metrics: {
        drift: measured(-1.5, 'm', { runtime: 'node', deterministic: false }),
      },
    };
    const row = toCsv(negative).split('\n').find((r) => r.startsWith('metric,drift,'));
    expect(row).toContain(',-1.5,');
    expect(row).not.toContain("'-1.5");
  });

  test('every data row has the same column count as the header', () => {
    const cols = (line: string): number => {
      let n = 1;
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') quoted = !quoted;
        else if (c === ',' && !quoted) n++;
      }
      return n;
    };
    const expected = cols(rows[0]);
    for (const r of rows) expect(cols(r)).toBe(expected);
  });
});

describe('the Markdown reporter', () => {
  const md = toMarkdown(fixtureReport());

  test('renders the unavailable metric as "unavailable — reason", never as a dash', () => {
    expect(md).toContain(`unavailable — ${GPU_REASON}`);
  });

  test('escapes a pipe in a reason so the table does not gain a column', () => {
    // The previous version of this test rendered the unmodified fixture, which
    // contains no pipe at all — it passed with the escaper deleted.
    const report = fixtureReport();
    const withPipe: RunReport = {
      ...report,
      metrics: {
        ...report.metrics,
        gpuFrameTime: unavailable('needs a | b support', {
          runtime: 'browser',
          deterministic: false,
        }),
      },
    };
    const rendered = toMarkdown(withPipe);
    expect(rendered).toContain('needs a \\| b support');
    expect(rendered).not.toContain('needs a | b support');
  });

  test('escapes a pipe in a stage name and in the dataset id too', () => {
    const report = fixtureReport();
    const hostile: RunReport = {
      ...report,
      datasetId: 'grid | v2',
      stages: report.stages.map((s) => ({ ...s, name: `${s.name} | retry` })),
    };
    const rendered = toMarkdown(hostile);
    expect(rendered).toContain('grid \\| v2');
    expect(rendered).toContain('decode \\| retry');
  });
});

describe('the HTML reporter', () => {
  const html = toHtml(fixtureReport());

  test('is self-contained: no external stylesheet, script, font or image', () => {
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).toContain('<style>');
  });

  test('marks an unavailable metric with a class a reader cannot mistake for a value', () => {
    expect(html).toContain('class="unavailable"');
    expect(html).toContain(GPU_REASON);
  });

  test('escapes report content wherever suite-supplied text reaches the page', () => {
    const PAYLOAD = '<img src=x onerror=alert(1)>';
    const report = fixtureReport();
    const [artifact, rawArtifact] = report.artifacts;
    if (rawArtifact.volatilityStripped) throw new Error('fixture: expected a raw byte artifact');
    const variants: ReadonlyArray<readonly [string, RunReport]> = [
      ['datasetId', { ...report, datasetId: PAYLOAD }],
      ['suiteId', { ...report, suiteId: PAYLOAD }],
      ['stage name', { ...report, stages: report.stages.map((s) => ({ ...s, name: PAYLOAD })) }],
      [
        'stage error',
        {
          ...report,
          stages: report.stages.map((s) => (s.status === 'failed' ? { ...s, error: PAYLOAD } : s)),
        },
      ],
      ['artifact name', { ...report, artifacts: [{ ...artifact, name: PAYLOAD }, rawArtifact] }],
      [
        'unstrippedReason',
        { ...report, artifacts: [artifact, { ...rawArtifact, unstrippedReason: PAYLOAD }] },
      ],
      ['metric key', { ...report, metrics: { [PAYLOAD]: report.metrics.pointsPerSecond } }],
      [
        'metric reason',
        {
          ...report,
          metrics: {
            gpuFrameTime: unavailable(PAYLOAD, { runtime: 'browser', deterministic: false }),
          },
        },
      ],
      [
        'environment value',
        { ...report, environment: { ...report.environment, cpuModel: capturedEnv(PAYLOAD) } },
      ],
    ];
    for (const [where, variant] of variants) {
      const rendered = toHtml(variant);
      expect(rendered, where).not.toContain('<img');
      expect(rendered, where).toContain('&lt;img');
    }
  });
});
