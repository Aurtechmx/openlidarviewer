/**
 * csv.ts
 *
 * The long-format CSV: one row per fact, eight fixed columns.
 *
 *   section,name,value,unit,status,reason,runtime,deterministic
 *
 * Long format rather than one wide row per run, because a run mixes stages,
 * suite-level metrics, environment fields and artifact hashes — shapes that do
 * not share a column set. Forcing them into one wide table means either a
 * ragged row count or empty cells that a spreadsheet renders identically to a
 * measured zero.
 *
 * The `status` and `reason` columns are what make the file honest: an
 * unmeasured metric writes the WORD `unavailable` in the value column and its
 * reason alongside, so no downstream `sum()` or plot can pick it up as a number.
 */

import type { Metric, RunReport, StageResult } from '../types';
import {
  UNAVAILABLE_LABEL,
  describeHashExclusions,
  metricReasonCell,
  metricUnitCell,
  metricValueCell,
} from './metricText';

const HEADER = 'section,name,value,unit,status,reason,runtime,deterministic';

/**
 * RFC-4180 quoting, plus the formula-injection neutraliser this repo already
 * applies in its measurement CSV export.
 *
 * Without the quoting, a reason containing a comma shifts every later column.
 * Without the neutraliser, a cell beginning `= + - @` or a tab/CR is executed as
 * a formula by Excel and Sheets — and these cells carry suite-supplied text
 * (dataset ids, stage names, error messages) that nobody vetted. A leading
 * apostrophe is the conventional fix; force-quoting keeps it.
 *
 * A cell that IS a number is left alone, so a negative measurement stays `-1.5`
 * rather than becoming the text `'-1.5` and dropping out of every chart — the
 * same carve-out the measurement export makes. `-1+1` is not a number and is
 * still neutralised.
 */
function cell(value: string): string {
  const numeric = value.trim() !== '' && Number.isFinite(Number(value));
  const neutralise = !numeric && /^[=+\-@\t\r]/.test(value);
  const out = neutralise ? `'${value}` : value;
  return neutralise || /[",\n\r]/.test(out) ? `"${out.replace(/"/g, '""')}"` : out;
}

function row(cells: readonly string[]): string {
  return cells.map(cell).join(',');
}

/** A metric row carries all eight columns; everything else leaves them empty. */
function metricRow(section: string, name: string, m: Metric): string {
  return row([
    section,
    name,
    metricValueCell(m),
    metricUnitCell(m),
    m.status,
    metricReasonCell(m),
    m.runtime,
    String(m.deterministic),
  ]);
}

/** A plain fact (dataset id, OS, hash): a value with no unit and no reason. */
function factRow(section: string, name: string, value: string, reason = ''): string {
  return row([section, name, value, '', reason === '' ? 'captured' : UNAVAILABLE_LABEL, reason, '', '']);
}

function stageRows(stage: StageResult): string[] {
  return [
    factRow('stage', `${stage.name}.status`, stage.status, ''),
    ...(stage.error === undefined ? [] : [factRow('stage', `${stage.name}.error`, stage.error, '')]),
    metricRow('stage', `${stage.name}.duration`, stage.duration),
    metricRow('stage', `${stage.name}.peakMemory`, stage.peakMemory),
  ];
}

export function toCsv(report: RunReport): string {
  const rows: string[] = [HEADER];

  rows.push(factRow('run', 'schemaVersion', String(report.schemaVersion)));
  rows.push(factRow('run', 'suiteId', report.suiteId));
  rows.push(factRow('run', 'datasetId', report.datasetId));

  for (const [name, field] of Object.entries(report.environment)) {
    rows.push(
      field.status === 'captured'
        ? factRow('environment', name, field.value)
        : factRow('environment', name, UNAVAILABLE_LABEL, field.reason),
    );
  }

  for (const stage of report.stages) rows.push(...stageRows(stage));
  for (const [name, metric] of Object.entries(report.metrics)) rows.push(metricRow('metric', name, metric));

  for (const artifact of report.artifacts) {
    rows.push(factRow('artifact', `${artifact.name}.hash`, artifact.hash));
    rows.push(factRow('artifact', `${artifact.name}.algorithm`, artifact.algorithm));
    rows.push(factRow('artifact', `${artifact.name}.fingerprint`, artifact.fingerprint));
    rows.push(factRow('artifact', `${artifact.name}.byteLength`, String(artifact.byteLength)));
    // Never an empty cell: "nothing was excluded" and "no strip could run" are
    // different answers, and the second is a caveat on the hash itself. The
    // boolean is emitted alongside the prose so a script can branch on it
    // without parsing the sentence.
    rows.push(factRow('artifact', `${artifact.name}.volatilityStripped`, String(artifact.volatilityStripped)));
    rows.push(factRow('artifact', `${artifact.name}.strippedFields`, describeHashExclusions(artifact)));
  }

  return `${rows.join('\n')}\n`;
}
