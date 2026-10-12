/**
 * loadScope.ts
 *
 * The words the open status uses for how much of a file a load covers. Each
 * label is read off a structured plan fact (the decode mode a plan already
 * chose, or the route a file took), never off the file size or a display
 * string, so the label cannot claim more than the plan does.
 *
 *   stride    -> "Sampled load"         one source record per stride is decoded
 *   voxel     -> "Thinned for display"  every record is decoded, the display is reduced
 *   all       -> "Standard load"        every record is decoded and shown up to the budget
 *   streaming -> "Streaming"            the file is read by range as the view needs it
 *
 * Pure: no DOM, no three.js. Presentation only; nothing here feeds a decode,
 * a measurement or an export.
 */

import type { LoadMode } from './loadPlan';
import { formatPointCount } from './loadPlan';
import type { SourceMetadata } from './PointCloudSource';

/** How much of a file an open covers, as the status line names it. */
export type LoadScope = 'standard' | 'thinned' | 'sampled' | 'streaming';

/** The scope a whole-file plan's decode mode implies. */
export function loadScopeForMode(mode: LoadMode): LoadScope {
  switch (mode) {
    case 'stride':
      return 'sampled';
    case 'voxel':
      return 'thinned';
    case 'all':
      return 'standard';
  }
}

/** The short label for a scope. */
export function loadScopeLabel(scope: LoadScope): string {
  switch (scope) {
    case 'sampled':
      return 'Sampled load';
    case 'thinned':
      return 'Thinned for display';
    case 'standard':
      return 'Standard load';
    case 'streaming':
      return 'Streaming';
  }
}

/** One plain sentence on what a scope means, for assistive technology. */
export function loadScopeDescription(scope: LoadScope): string {
  switch (scope) {
    case 'sampled':
      return 'Source records are sampled.';
    case 'thinned':
      return 'All records are decoded; the display is reduced.';
    case 'standard':
      return 'Records are decoded without sampling.';
    case 'streaming':
      return 'The file is read in parts as the view needs them.';
  }
}

/**
 * A point count fit to show before decoding, or `undefined` when it is not
 * known. A header that declares zero or a value that is not a finite positive
 * number is treated as unknown rather than shown, so the status never prints a
 * zero or a guessed count.
 */
export function knownPointCount(count: number | undefined): number | undefined {
  return count !== undefined && Number.isFinite(count) && count > 0 ? count : undefined;
}

/** The short format name shown beside the file name, e.g. `E57`, `LAZ`. */
export function shortFormatName(format: string): string {
  return format.toUpperCase();
}

/** The status facts for one open, in display order, plus what to announce. */
export interface LoadContextFacts {
  /** Format, then scope, then the source count when the header states one. */
  readonly facts: string[];
  /** One sentence for assistive technology: the facts and what the scope means. */
  readonly announce: string;
  /** The preflight warning or refusal reason, verbatim. */
  readonly note?: string;
}

/**
 * The status facts a finished preflight supports. Built from the structured
 * metadata only; nothing is read back out of a display line, and preflight is
 * not run again.
 */
export function loadContextFacts(meta: Pick<SourceMetadata, 'format' | 'loadScope' | 'estimatedPointCount' | 'warning'>): LoadContextFacts {
  return contextFacts(meta.format, meta.loadScope, knownPointCount(meta.estimatedPointCount), meta.warning);
}

/** The status facts for a route that streams the file instead of reading it whole. */
export function streamingContextFacts(formatName: string | undefined): LoadContextFacts {
  return contextFacts(formatName, 'streaming', undefined, undefined);
}

function contextFacts(
  format: string | undefined,
  scope: LoadScope | undefined,
  count: number | undefined,
  note: string | undefined,
): LoadContextFacts {
  const facts: string[] = [];
  if (format) facts.push(shortFormatName(format));
  if (scope) facts.push(loadScopeLabel(scope));
  if (count !== undefined) facts.push(`${formatPointCount(count)} source points`);
  const spoken = [facts.join(', '), scope ? loadScopeDescription(scope) : ''].filter(Boolean).join('. ');
  return note ? { facts, announce: spoken, note } : { facts, announce: spoken };
}
