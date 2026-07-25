/**
 * html.ts
 *
 * The self-contained HTML report — a single file that can be attached to a
 * release, opened from a USB stick, or archived in a data repository and still
 * render identically in ten years.
 *
 * Self-contained is a hard constraint, not a preference: no stylesheet link, no
 * script tag, no web font, no remote image. An artifact that fetches anything
 * over the network stops rendering the day that host goes away, and it leaks the
 * reader's inspection of an archived result to a third party. All styling is one
 * inline `<style>` block using system fonts.
 *
 * Every interpolated string is escaped. Report content includes dataset ids and
 * error messages that come from files and tools, and a `<` in one of those must
 * render as a `<`, not restructure the document.
 */

import { isMeasured, type EnvValue, type Metric, type RunReport } from '../types';
import { describeHashExclusions, UNAVAILABLE_LABEL } from './metricText';

/** Escape the five characters that can break out of text or an attribute. */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A metric cell. The unavailable case gets its own class AND spells out the
 * reason inline: a styled blank would still read as "measured, and small".
 */
function metricCell(m: Metric): string {
  if (isMeasured(m)) {
    return `<td><span class="value">${esc(String(m.value))}</span> <span class="unit">${esc(m.unit)}</span></td>`;
  }
  return `<td class="unavailable"><span class="tag">${UNAVAILABLE_LABEL}</span> <span class="reason">${esc(m.reason)}</span></td>`;
}

function envCell(e: EnvValue): string {
  if (e.status === 'captured') return `<td>${esc(e.value)}</td>`;
  return `<td class="unavailable"><span class="tag">${UNAVAILABLE_LABEL}</span> <span class="reason">${esc(e.reason)}</span></td>`;
}

function textCell(value: string): string {
  return `<td>${esc(value)}</td>`;
}

function headerRow(labels: readonly string[]): string {
  return `<tr>${labels.map((l) => `<th>${esc(l)}</th>`).join('')}</tr>`;
}

// System-font stack only, and no `url()` anywhere, so the file never reaches out.
const STYLE = `
:root { color-scheme: light dark; }
body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
       margin: 2rem auto; max-width: 68rem; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
h2 { font-size: 1.1rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.9rem; }
th, td { border: 1px solid rgba(128,128,128,0.4); padding: 0.35rem 0.55rem; text-align: left;
         vertical-align: top; }
th { background: rgba(128,128,128,0.12); font-weight: 600; }
code, .hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em;
              word-break: break-all; }
.unit { opacity: 0.75; }
.unavailable .tag { font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
                    font-size: 0.75em; padding: 0.05rem 0.3rem; border: 1px solid currentColor;
                    border-radius: 0.2rem; }
.unavailable .reason { opacity: 0.85; font-style: italic; }
.failed { font-weight: 600; }
.note { font-size: 0.85rem; opacity: 0.8; margin-top: 2rem; }
`.trim();

export function toHtml(report: RunReport): string {
  const env = report.environment;

  const runRows = [
    ['suite', report.suiteId],
    ['dataset', report.datasetId],
    ['schema version', String(report.schemaVersion)],
  ]
    .map(([k, v]) => `<tr><th>${esc(k)}</th>${textCell(v)}</tr>`)
    .join('');

  const envRows = (
    [
      ['release version', env.releaseVersion],
      ['git commit', env.gitCommitShort],
      ['git commit (full)', env.gitCommitFull],
      ['OS', env.os],
      ['CPU', env.cpuModel],
      ['arch', env.arch],
      ['Node', env.nodeVersion],
    ] as ReadonlyArray<readonly [string, EnvValue]>
  )
    .map(([k, v]) => `<tr><th>${esc(k)}</th>${envCell(v)}</tr>`)
    .join('');

  const stageRows = report.stages
    .map(
      (s) =>
        `<tr>${textCell(s.name)}<td${s.status === 'failed' ? ' class="failed"' : ''}>${esc(s.status)}</td>` +
        `${metricCell(s.duration)}${metricCell(s.peakMemory)}${textCell(s.error ?? '')}</tr>`,
    )
    .join('');

  const metricRows = Object.entries(report.metrics)
    .map(
      ([name, m]) =>
        `<tr>${textCell(name)}${metricCell(m)}${textCell(m.runtime)}${textCell(String(m.deterministic))}</tr>`,
    )
    .join('');

  const artifactRows = report.artifacts
    .map(
      (a) =>
        `<tr>${textCell(a.name)}${textCell(a.algorithm)}<td class="hash">${esc(a.hash)}</td>` +
        `${textCell(String(a.byteLength))}` +
        // The "no strip could run" case is a caveat on the hash, so it is
        // marked the same way an unavailable metric is rather than sitting in a
        // plain cell that reads like a field list.
        `<td${a.volatilityStripped ? '' : ' class="unavailable"'}>${esc(describeHashExclusions(a))}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>Benchmark run — ${esc(report.suiteId)}</title>
<style>${STYLE}</style>
<h1>Benchmark run — ${esc(report.suiteId)}</h1>
<h2>Run</h2>
<table>${runRows}</table>
<h2>Environment</h2>
<table>${envRows}</table>
<h2>Stages</h2>
<table>${headerRow(['stage', 'status', 'duration', 'peak RSS', 'error'])}${stageRows}</table>
<h2>Metrics</h2>
<table>${headerRow(['metric', 'value', 'runtime', 'deterministic'])}${metricRows}</table>
<h2>Artifacts</h2>
<table>${headerRow(['artifact', 'algorithm', 'hash', 'bytes', 'excluded from hash'])}${artifactRows}</table>
<p class="note">A cell marked ${UNAVAILABLE_LABEL} was not measured in this run. It is not zero,
and it is not an estimate — the stated reason is why no number exists.</p>
`;
}
