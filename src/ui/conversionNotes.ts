/**
 * conversionNotes.ts: the list of everything a conversion warned about.
 *
 * The Export panel and the batch converter show the same list: a one-line
 * summary and the full set of warnings and translations under it. Both read
 * `notableEntries`, so neither can show a shorter list than the other.
 */

import { notableEntries, warningSummary } from '../convert/conversionEvents';
import type { ConvertReport } from '../convert/types';
import { el } from './dom';

/**
 * The notes for one conversion, or null when it warned about nothing. The
 * details open by default so no warning is hidden behind a click.
 */
export function conversionNotes(report: Pick<ConvertReport, 'log' | 'events'>): HTMLElement | null {
  const entries = notableEntries(report);
  if (entries.length === 0) return null;
  const list = el('ul', { className: 'olv-conv-notes-list' });
  for (const entry of entries) {
    list.append(el('li', { className: `olv-conv-note is-${entry.level}`, text: entry.message }));
  }
  const summary = el('summary', { className: 'olv-conv-notes-summary', text: `Details: ${warningSummary(entries)}` });
  const box = el('details', { className: 'olv-conv-notes' }, [summary, list]);
  box.setAttribute('open', '');
  return box;
}

/** The status line after a write: the outcome and the count, not the first warning. */
export function exportedLine(points: number, entries: number, summary: string, scope: string): string {
  const head = `Exported ${points.toLocaleString()} point${points === 1 ? '' : 's'}`;
  return entries > 0 ? `${head} with ${summary}${scope}` : `${head}${scope}`;
}
