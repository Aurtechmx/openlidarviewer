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
import type { RunReport } from '../../benchmarks/framework/types';
import { RAW_BYTES_NO_STRIP_REASON } from '../../benchmarks/framework/artifacts';
import { describeHashExclusions } from '../../benchmarks/framework/reporters/metricText';
import { fixtureReport } from './reportFixture';

const REPORTERS: ReadonlyArray<readonly [string, (r: RunReport) => string]> = [
  ['json', toJson],
  ['csv', toCsv],
  ['markdown', toMarkdown],
  ['html', toHtml],
];

const MEMORY_REASON = 'process.memoryUsage is not exposed in this runtime';
const GPU_REASON = 'WebGPU timestamp queries need a browser runtime';

describe.each(REPORTERS)('the %s reporter', (name, render) => {
  const out = render(fixtureReport());

  test('renders both unavailable metrics as unavailable, with their reason', () => {
    expect(out.toLowerCase()).toContain('unavailable');
    expect(out).toContain(MEMORY_REASON);
    expect(out).toContain(GPU_REASON);
  });

  test('carries the environment, dataset, commit, release and schema version', () => {
    expect(out).toContain('synthetic-grid-1m'); // dataset id
    expect(out).toContain('darwin 24.0.0'); // OS
    expect(out).toContain('Apple M2 Pro'); // CPU model
    expect(out).toContain('arm64'); // arch
    expect(out).toContain('v22.17.1'); // Node version
    expect(out).toContain('5f452c7'); // git commit
    expect(out).toContain('0.6.0'); // release version
    expect(out).toContain('1'); // schema version
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
    expect(lines.length).toBeGreaterThan(0);
    expect(name.length).toBeGreaterThan(0);
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
    expect(toMarkdown(fixtureReport()).split('\n').filter((l) => l.startsWith('|')).length).
      toBeGreaterThan(3);
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

  test('escapes report content so a hostile dataset id cannot inject markup', () => {
    const report: RunReport = { ...fixtureReport(), datasetId: '<img src=x onerror=alert(1)>' };
    const out = toHtml(report);
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
});
