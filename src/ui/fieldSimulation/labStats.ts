/**
 * labStats.ts — the compact figure row under a Lab result grid: a few key
 * values in large tabular numerals, each with a small unit and a label. The
 * full figures stay in the result card; this row is the at-a-glance summary.
 */

import { el } from '../dom';

export interface LabStat {
  readonly label: string;
  /** The figure as displayed, already rounded to the precision the data supports. */
  readonly value: string;
  /** Unit after the figure; empty for a plain count. */
  readonly unit?: string;
}

export function labStatRow(title: string, stats: readonly LabStat[]): HTMLElement {
  // The wrapper is the size container: two columns in a narrow panel, four in a wide one.
  const list = el('dl', { className: 'olv-lab-stats', ariaLabel: title }, stats.map((s) =>
    el('div', { className: 'olv-lab-stat' }, [
      el('dt', { className: 'olv-lab-stat-label', text: s.label }),
      el('dd', { className: 'olv-lab-stat-value' }, [
        el('span', { className: 'olv-lab-stat-num', text: s.value }),
        ...(s.unit ? [el('span', { className: 'olv-lab-stat-unit', text: s.unit })] : []),
      ]),
    ])));
  return el('div', { className: 'olv-lab-stats-wrap' }, [list]);
}

/** A small north arrow for the corner of a north-up grid. */
export function northBadge(): HTMLElement {
  const badge = el('span', { className: 'olv-lab-north', text: 'N' });
  badge.setAttribute('role', 'img');
  badge.setAttribute('aria-label', 'North is up');
  return badge;
}
