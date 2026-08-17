/**
 * collapsibleSection.ts
 *
 * A `<details>`-based collapsible section with a summary label. Shared by the
 * Inspector and the Output panel's export deliverables, so the same disclosure
 * idiom (and its CSS) is authored once.
 */

import { el } from './dom';

export function collapsibleSection(
  label: string,
  body: HTMLElement,
  opts: { readonly open?: boolean } = {},
): HTMLDetailsElement {
  const details = el('details', {
    className: 'olv-section olv-section-collapsible',
  }) as HTMLDetailsElement;
  if (opts.open) details.open = true;
  const summary = el('summary', {
    className: 'olv-section-label olv-section-summary',
    text: label,
  });
  details.append(summary, body);
  return details;
}
