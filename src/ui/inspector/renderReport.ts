/**
 * renderReport.ts
 *
 * The Inspector's "Scan report" body, split out of `Inspector.ts` as a lazy
 * chunk (loaded via `loadRenderReport()` in `lazyChunks.ts`). `setReport` is
 * called eagerly on every scan open (5 call sites across `openScan.ts`,
 * `heavyLasExecutor.ts`, `openTilesetLayer.ts`, `openStreaming.ts`) even
 * though "Scan report" is collapsed by default — this pulls that DOM build,
 * and the `scopeStamp`/`classificationLabel` helpers it depends on, out of
 * the eager `index` chunk.
 *
 * Pure render function — no state of its own. `Inspector.setReport()` keeps
 * its synchronous, `void`-returning signature; it shows a loading
 * placeholder, imports this module, then calls `renderReport` once the
 * chunk resolves.
 */

import { el } from '../dom';
import type { AnalysisRow } from '../../analysis/ModuleApi';
import { scopeStamp } from '../../render/class/classScope';
import { classificationLabel } from '../../render/pointInfo';

/**
 * Build a single status / label / value report row. `truncate` clips long
 * declared-metadata values for display, keeping the verbatim value one
 * hover away in the tooltip.
 */
function reportRow(row: AnalysisRow, truncate = false): HTMLElement {
  // Honesty stamp — when a metric was computed under a class filter (subset)
  // or is a header figure that can't be class-scoped (notScoped sentinel),
  // append the scope provenance after the value so no filtered readout is
  // shown unqualified. A full / absent scope yields an empty stamp and the
  // row renders exactly as it did before class scoping existed.
  const stamp = row.scope ? scopeStamp(row.scope, classificationLabel) : '';
  // Truncated declared values keep the verbatim text in the tooltip.
  const valueProps: Parameters<typeof el>[1] = { className: 'olv-report-value' };
  let shown = row.value;
  if (truncate && shown.length > 96) {
    valueProps.title = shown;
    shown = `${shown.slice(0, 96)}…`;
  }
  const valueChildren: (HTMLElement | string)[] = [shown];
  if (stamp) {
    valueChildren.push(
      el('span', {
        className: 'olv-report-scope',
        text: ` · ${stamp}`,
        title: 'Class scope this metric was computed under',
      }),
    );
  }
  return el('div', { className: 'olv-report-row' }, [
    el('span', {
      className: `olv-status olv-status-${row.status}`,
      // Accessibility: status is encoded by colour only — add a
      // textual label so screen readers and assistive tech announce
      // pass / info / warn / fail. Visual redundancy (a glyph inside
      // the dot) is a follow-up.
      ariaLabel: ({
        pass: 'Pass',
        info: 'Info',
        warn: 'Warning',
        fail: 'Fail',
      } as const)[row.status],
    }),
    el('span', { className: 'olv-report-label', text: row.label }),
    el('span', valueProps, valueChildren),
  ]);
}

/**
 * Render the report rows into `container`. Rows marked `advanced` (the
 * health diagnostics) are tucked into a collapsible "Advanced report" so
 * the default view stays clean; `src-std`/`src-ext` rows go under a
 * collapsible "Source metadata" instead.
 */
export function renderReport(container: HTMLElement, rows: AnalysisRow[]): void {
  container.replaceChildren();
  const advanced: AnalysisRow[] = [];
  const sourceStd: AnalysisRow[] = [];
  const sourceExt: AnalysisRow[] = [];
  for (const row of rows) {
    if (row.group === 'src-std') sourceStd.push(row);
    else if (row.group === 'src-ext') sourceExt.push(row);
    else if (row.advanced) advanced.push(row);
    else container.append(reportRow(row));
  }
  // Shared collapsible builder for the Advanced report and the declared
  // Source metadata sections.
  const fold = (title: string, children: (HTMLElement | string)[]): void => {
    container.append(
      el('details', { className: 'olv-advanced' }, [
        el('summary', { className: 'olv-advanced-summary', text: title }),
        el('div', { className: 'olv-advanced-body' }, children),
      ]),
    );
  };
  if (advanced.length > 0) {
    fold('Advanced report', advanced.map((row) => reportRow(row)));
  }
  // Declared source metadata — rendered only when the file declared
  // something. Values are verbatim declarations; the disclosure line keeps
  // the honesty boundary explicit ("declared, not verified").
  if (sourceStd.length > 0 || sourceExt.length > 0) {
    const children: HTMLElement[] = [
      el('div', {
        className: 'olv-report-empty',
        text: 'Declared by the file, not verified by OpenLiDARViewer.',
      }),
      ...sourceStd.map((row) => reportRow(row, true)),
    ];
    if (sourceExt.length > 0) {
      children.push(
        el('div', {
          className: 'olv-advanced-summary',
          text: 'Extended metadata (file-declared)',
        }),
        ...sourceExt.map((row) => reportRow(row, true)),
      );
    }
    fold('Source metadata', children);
  }
}
