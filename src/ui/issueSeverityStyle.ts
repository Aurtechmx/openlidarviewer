/**
 * issueSeverityStyle.ts
 *
 * How an inspection severity is PRESENTED. The vocabulary lives here once, so
 * the annotation editor and the annotations panel show the same four ranks the
 * same way; `render/annotate/issueWorkflow.ts` stays pure data and says nothing
 * about glyphs.
 *
 * Severity is never carried by colour alone. Each rank gets a rising bar whose
 * HEIGHT encodes the rank, and the word is rendered beside it wherever there is
 * room for it. A reader in forced-colours mode, in greyscale print, or with any
 * colour-vision deficiency still gets the ordering from the bar and the rank
 * from the word; colour only reinforces what those two already say.
 */

import type { IssueSeverity } from '../render/annotate/issueWorkflow';

/**
 * The rank as a shape: a bar that rises with severity. Ordered by the same
 * ranking `issueSeverityRank` defines, so the taller mark is the worse
 * condition without a legend.
 */
export const SEVERITY_GLYPH: Record<IssueSeverity, string> = {
  low: '▁',
  medium: '▃',
  high: '▆',
  critical: '█',
};

/** The rank as a word, capitalised for display. */
export const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

/** Bar and word together — the full-width form, used wherever it fits. */
export function severityText(severity: IssueSeverity): string {
  return `${SEVERITY_GLYPH[severity]} ${SEVERITY_LABEL[severity]}`;
}

/**
 * The accessible name for a severity mark. The bar is decoration to a screen
 * reader, so the name has to carry the rank in words.
 */
export function severityAriaLabel(severity: IssueSeverity): string {
  return `Severity: ${SEVERITY_LABEL[severity]}`;
}
