/**
 * profileDerivedLegend.ts
 *
 * The legend for the derived surface a profile cross-section can draw over its
 * observed returns.
 *
 * What that overlay actually is: for each station along the section, the
 * sampler takes a LOW PERCENTILE of the heights inside the station's corridor,
 * having first dropped the vegetation / building / noise classes wherever a
 * source supplied a classification channel (see `profileSampler.ts` and
 * `classificationFilter.ts`). It is an ESTIMATE derived from returns, not a
 * return series, and not bare earth: a corridor whose returns were never
 * classified still contributes its canopy to the percentile, and a percentile
 * is a statistic over whatever was there, not a decision about what the
 * surface is made of.
 *
 * So the label matters as much as the maths. This module refuses to name the
 * series after a terrain class it cannot certify, and states, every time:
 *
 *   - the percentile actually used (not the default, the one that ran);
 *   - the station count and the corridor half width the estimate came from;
 *   - the class-exclusion policy AND whether classification existed on every
 *     contributing source, because a policy that could only be applied to some
 *     sources was not applied to the section;
 *   - the classification provenance across sources — producer, OLV-derived,
 *     absent, or mixed — never one source's answer spoken for all of them;
 *   - whether the read saw the full static sources or a resident streaming
 *     snapshot, which is a subset by definition;
 *   - how many stations are coverage gaps, so the reader knows the polyline is
 *     broken rather than continuous.
 *
 * Pure: strings and numbers in, strings and numbers out. No DOM, no three.js,
 * no Viewer. The caller renders it.
 */

import { DEFAULT_GROUND_PERCENTILE } from './profileSampler';
import type { ProfileSample } from './profileSampler';
import { NON_GROUND_CLASSES } from '../../terrain/ground/classificationFilter';

/**
 * Where one contributing source's classification channel came from.
 *   `producer` — shipped with the survey / delivered file.
 *   `derived`  — assigned by OLV (auto-classify or the lasso editor).
 *   `absent`   — the source carries no classification channel at all.
 */
export type SourceClassificationProvenance = 'producer' | 'derived' | 'absent';

/**
 * The provenance of the section as a whole. `mixed` is its own answer: when
 * sources disagree, reporting any single one of them would attribute a
 * property to data that does not have it.
 */
export type SectionClassificationProvenance = SourceClassificationProvenance | 'mixed';

/** How a source's points were read for this walk. */
export type SourceReadKind = 'static' | 'streaming-resident';

/**
 * The section's read scope. `resident-snapshot` and `partial-resident` both
 * mean the walk did not see every point the sources hold; `unknown` is the
 * empty-section answer, since "full static" would be a claim about a read
 * that never happened.
 */
export type SectionReadScope = 'full-static' | 'resident-snapshot' | 'partial-resident' | 'unknown';

/** Whether the class-exclusion policy could reach the whole section. */
export type ExclusionScope = 'every-source' | 'partial' | 'none';

/** One point-cloud source contributing returns to the section. */
export interface DerivedSurfaceSource {
  /** Optional display name, used only in the per-source provenance breakdown. */
  readonly label?: string;
  /** Where this source's classification channel came from. */
  readonly classification: SourceClassificationProvenance;
  /** Whether the walk read the whole static source or a resident snapshot. */
  readonly read: SourceReadKind;
}

/** Everything the legend needs about the walk that produced the overlay. */
export interface DerivedSurfaceLegendInput {
  /** The sampled stations. A non-finite height is a coverage gap. */
  readonly samples: readonly ProfileSample[];
  /**
   * The percentile the sampler ran with. `null` / omitted means the sampler's
   * own default was used, and the legend resolves it the same way the sampler
   * does, so the printed number is always the number that ran.
   */
  readonly percentile?: number | null;
  /** Corridor half width in metres; `null` when the caller did not record it. */
  readonly corridorHalfWidthM?: number | null;
  /** The sources that contributed returns to this walk. */
  readonly sources: readonly DerivedSurfaceSource[];
  /** ASPRS classes dropped where classification existed. Defaults to the sampler's set. */
  readonly excludedClasses?: readonly number[];
}

/** One of the three ways a caller may present the section. */
export type ProfileDisplayModeId = 'observed' | 'observed-and-derived' | 'derived-only';

export interface ProfileDisplayMode {
  readonly id: ProfileDisplayModeId;
  readonly label: string;
  /** What the reader is looking at in this mode, stated without a terrain claim. */
  readonly detail: string;
}

/** The legend: machine-readable facts plus the sentences that state them. */
export interface DerivedSurfaceLegend {
  /** The series name. Never a terrain-class claim. */
  readonly seriesLabel: string;
  /** The percentile that actually ran, resolved and clamped as the sampler does. */
  readonly percentileUsed: number;
  /** True when `percentile` was absent and the sampler default was resolved. */
  readonly percentileWasDefault: boolean;
  readonly stationCount: number;
  /** Stations with a non-finite height: no returns in the corridor. */
  readonly gapStationCount: number;
  readonly coveredStationCount: number;
  readonly corridorHalfWidthM: number | null;
  readonly excludedClasses: readonly number[];
  readonly exclusionScope: ExclusionScope;
  readonly sourceCount: number;
  readonly sourcesWithClassification: number;
  readonly classificationProvenance: SectionClassificationProvenance;
  readonly readScope: SectionReadScope;
  /** One-line summary for a chart legend swatch. */
  readonly caption: string;
  /** The full statement, one sentence group per line. */
  readonly lines: readonly string[];
  /** The three presentation choices a caller may offer. */
  readonly displayModes: readonly ProfileDisplayMode[];
}

/** Trim a number to at most `dp` decimals without a trailing `.0`. */
function num(value: number, dp: number): string {
  const fixed = value.toFixed(dp);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}

/** English list joining: "a", "a and b", "a, b and c". */
function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

const PROVENANCE_PHRASE: Readonly<Record<SourceClassificationProvenance, string>> = {
  producer: 'producer classification',
  derived: 'OLV-derived classification',
  absent: 'no classification channel',
};

/**
 * Resolve the percentile exactly as `sampleProfile` does: absent / non-finite
 * falls back to the sampler default, and the value is clamped to 0..100 the
 * way the quantile estimator clamps it. Anything else would print a number
 * that did not shape the estimate.
 */
function resolvePercentile(p: number | null | undefined): { value: number; wasDefault: boolean } {
  if (p == null || !Number.isFinite(p)) return { value: DEFAULT_GROUND_PERCENTILE, wasDefault: true };
  return { value: Math.min(100, Math.max(0, p)), wasDefault: false };
}

function summariseProvenance(
  sources: readonly DerivedSurfaceSource[],
): SectionClassificationProvenance {
  if (sources.length === 0) return 'absent';
  const seen = new Set<SourceClassificationProvenance>();
  for (const s of sources) seen.add(s.classification);
  if (seen.size > 1) return 'mixed';
  return sources[0].classification;
}

function summariseRead(sources: readonly DerivedSurfaceSource[]): SectionReadScope {
  if (sources.length === 0) return 'unknown';
  let statics = 0;
  let resident = 0;
  for (const s of sources) {
    if (s.read === 'streaming-resident') resident++;
    else statics++;
  }
  if (resident === 0) return 'full-static';
  if (statics === 0) return 'resident-snapshot';
  return 'partial-resident';
}

function exclusionScopeOf(sources: readonly DerivedSurfaceSource[], classified: number): ExclusionScope {
  if (sources.length === 0 || classified === 0) return 'none';
  return classified === sources.length ? 'every-source' : 'partial';
}

function provenanceLine(
  provenance: SectionClassificationProvenance,
  sources: readonly DerivedSurfaceSource[],
): string {
  if (sources.length === 0) return 'Classification provenance: no contributing source was recorded.';
  if (provenance !== 'mixed') {
    return `Classification provenance: ${PROVENANCE_PHRASE[provenance]} on ${
      sources.length === 1 ? 'the single source' : `all ${sources.length} sources`
    }.`;
  }
  const parts = sources.map(
    (s, i) => `${s.label ?? `source ${i + 1}`}: ${PROVENANCE_PHRASE[s.classification]}`,
  );
  return `Classification provenance: mixed across ${sources.length} sources (${joinList(parts)}).`;
}

function exclusionLine(
  scope: ExclusionScope,
  excluded: readonly number[],
  classified: number,
  total: number,
): string {
  const classes = `Classes ${excluded.join(', ')} (vegetation, building, noise)`;
  if (scope === 'none') {
    return total === 0
      ? 'Class exclusion: not applied, no contributing source was recorded.'
      : `Class exclusion: not applied. No contributing source carries a classification channel, so ${
          total === 1 ? 'its' : 'their'
        } vegetation, building and noise returns reached the percentile.`;
  }
  if (scope === 'every-source') {
    return `${classes} excluded on every contributing source (${classified} of ${total}).`;
  }
  return `${classes} excluded on only ${classified} of ${total} sources: partial. The ${
    total - classified
  } unclassified ${plural(total - classified, 'source', 'sources')} contributed every return it held, so the exclusion did not apply to the whole section.`;
}

function readLine(scope: SectionReadScope): string {
  switch (scope) {
    case 'full-static':
      return 'Read: the full static sources.';
    case 'resident-snapshot':
      return 'Read: a resident streaming snapshot, not the full sources. Points outside the resident set were never sampled.';
    case 'partial-resident':
      return 'Read: part static, part resident streaming snapshot. The streaming part is a subset, so the section is not a full read.';
    default:
      return 'Read: not recorded, so the coverage of this estimate is unknown.';
  }
}

function gapLine(gaps: number, stations: number): string {
  if (stations === 0) return 'Coverage gaps: 0 of 0 stations, the section holds no stations.';
  if (gaps === 0) {
    return `Coverage gaps: 0 of ${stations} stations. Every station had returns in its corridor.`;
  }
  return `Coverage gaps: ${gaps} of ${stations} ${plural(
    stations,
    'station',
    'stations',
  )} had no returns in the corridor. The line breaks at those stations and is never interpolated across them.`;
}

/** The three presentation choices, worded so none of them implies a terrain class. */
function buildDisplayModes(percentile: number): readonly ProfileDisplayMode[] {
  return [
    {
      id: 'observed',
      label: 'Observed returns',
      detail: 'Only the measured returns in the corridor. Nothing is estimated.',
    },
    {
      id: 'observed-and-derived',
      label: 'Observed returns with derived surface',
      detail: `The measured returns with the ${num(percentile, 1)}th-percentile estimate drawn over them, so the estimate can be checked against the returns it came from.`,
    },
    {
      id: 'derived-only',
      label: 'Derived surface only',
      detail: `Only the ${num(percentile, 1)}th-percentile estimate. The returns behind it are hidden, so nothing on screen shows how well it is supported.`,
    },
  ];
}

/**
 * Build the legend for a derived-surface overlay.
 *
 * Every string this returns is safe to show beside the chart, and none of them
 * names a terrain class: the series is described by the operation that made it
 * (a percentile over a corridor), which is the one thing that is certainly
 * true about it.
 */
export function buildDerivedSurfaceLegend(input: DerivedSurfaceLegendInput): DerivedSurfaceLegend {
  const { value: percentileUsed, wasDefault: percentileWasDefault } = resolvePercentile(
    input.percentile,
  );

  const stationCount = input.samples.length;
  let gapStationCount = 0;
  for (const s of input.samples) if (!Number.isFinite(s.height)) gapStationCount++;
  const coveredStationCount = stationCount - gapStationCount;

  const sources = input.sources;
  const sourcesWithClassification = sources.filter((s) => s.classification !== 'absent').length;
  const exclusionScope = exclusionScopeOf(sources, sourcesWithClassification);
  const classificationProvenance = summariseProvenance(sources);
  const readScope = summariseRead(sources);

  const excludedClasses = (input.excludedClasses ?? NON_GROUND_CLASSES).slice();

  const halfWidth =
    input.corridorHalfWidthM != null && Number.isFinite(input.corridorHalfWidthM)
      ? input.corridorHalfWidthM
      : null;

  const pct = num(percentileUsed, 1);
  const seriesLabel = `Derived surface (${pct}th percentile of corridor returns)`;

  const geometryLine =
    halfWidth == null
      ? `${stationCount} ${plural(stationCount, 'station', 'stations')} along the section. Corridor half width: not recorded.`
      : `${stationCount} ${plural(stationCount, 'station', 'stations')} along the section, corridor half width ${num(halfWidth, 3)} m each side of the line.`;

  const lines: string[] = [
    `${seriesLabel}. Estimated, not measured.`,
    `Each station reduces the returns in its corridor to one height at the ${pct}th percentile${
      percentileWasDefault ? ' (the sampler default)' : ''
    }. A percentile is a statistic over the returns that were present, so this is an estimated surface and not a return series.`,
    geometryLine,
    exclusionLine(exclusionScope, excludedClasses, sourcesWithClassification, sources.length),
    provenanceLine(classificationProvenance, sources),
    readLine(readScope),
    gapLine(gapStationCount, stationCount),
  ];

  const caption = `${seriesLabel}, ${stationCount} ${plural(
    stationCount,
    'station',
    'stations',
  )}, ${gapStationCount} ${plural(gapStationCount, 'gap', 'gaps')}. Estimated, not measured.`;

  return {
    seriesLabel,
    percentileUsed,
    percentileWasDefault,
    stationCount,
    gapStationCount,
    coveredStationCount,
    corridorHalfWidthM: halfWidth,
    excludedClasses,
    exclusionScope,
    sourceCount: sources.length,
    sourcesWithClassification,
    classificationProvenance,
    readScope,
    caption,
    lines,
    displayModes: buildDisplayModes(percentileUsed),
  };
}

/**
 * Every string the legend produces, flattened. The banned-vocabulary test
 * walks this, so a new string field added above cannot escape the check by
 * being somewhere the test did not look.
 */
export function derivedSurfaceLegendStrings(legend: DerivedSurfaceLegend): readonly string[] {
  return [
    legend.seriesLabel,
    legend.caption,
    ...legend.lines,
    ...legend.displayModes.flatMap((m) => [m.label, m.detail]),
  ];
}
