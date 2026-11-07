/**
 * watershedNarrative.ts — the plain-language summary of one catchment: a
 * headline and the flow told in order (starts, gathers, joins, ponds,
 * leaves), with an open-catchment warning last when it applies.
 *
 * Every figure goes through the catalog as a parameter; a withheld figure is
 * told by its reason. Pure: no DOM, no I/O.
 */

import type { Figure, WithheldReason } from './catchmentMorphometrics';
import type { CatchmentQuality } from './catchmentQuality';
import { MAX_FAR_INTERPOLATED_RUN, SUPPORTED_CHANNEL_INTERPOLATED_SHARE, SUPPORTED_MEASURED_SHARE } from './catchmentQuality';
import type { CatchmentSection, ReportLanguage } from './watershedReportModel';
import { DEFAULT_NETWORK_THRESHOLD_M2 } from './flowNetwork';
import { UNIT_GAP, compassOf, formatArea, formatNumber, t, type StringKey } from './watershedStrings';

export interface NarrativeParagraph {
  readonly lead: StringKey;
  readonly text: string;
}

/** Elongation ratio Re limits for the headline's shape word (Schumm 1956). */
export const RE_NEAR_CIRCULAR_MIN = 0.9;
export const RE_OVAL_MIN = 0.7;

export function formatLength(lang: ReportLanguage, m: number): string {
  return `${formatNumber(lang, m, 0)}${UNIT_GAP}m`;
}

export function formatPercent(lang: ReportLanguage, fraction: number, digits = 1): string {
  return `${formatNumber(lang, fraction * 100, digits)}${UNIT_GAP}%`;
}

export function formatHeight(lang: ReportLanguage, m: number): string {
  return `${formatNumber(lang, m, 1)}${UNIT_GAP}m`;
}

/** The catalog's reason for a withheld figure. */
export function withheldText(lang: ReportLanguage, reason: WithheldReason): string {
  return t(lang, `withheld.${reason}` as StringKey);
}

function join(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join(' ');
}

// The story places the water; it does not restate the KPI or table figures
// (relief, channel length, slopes, flow-line length).

function starts(s: CatchmentSection, lang: ReportLanguage): string {
  const first = t(lang, s.quality.complete ? 'narrative.starts.closed' : 'narrative.starts.open');
  const h = s.geometry.highPoint;
  const second = h.dxM === 0 && h.dyM === 0 ? '' : t(lang, 'narrative.starts.highPoint', {
    distance: formatLength(lang, Math.hypot(h.dxM, h.dyM)),
    direction: compassOf(h.dxM, h.dyM, lang),
  });
  return join(first, second);
}

function hasLines(s: CatchmentSection): boolean {
  // A flow line cell inside the mask counts even when its length is zero (an edge outlet).
  return s.network.maxOrder >= 1;
}

function gathers(s: CatchmentSection, lang: ReportLanguage, thresholdM2: number): string {
  if (!hasLines(s)) return t(lang, 'narrative.gathers.none', { threshold: formatArea(lang, thresholdM2) });
  const head = s.geometry.channelHead;
  if (head === null || (head.dxM === 0 && head.dyM === 0)) return t(lang, 'narrative.gathers.lines');
  return t(lang, 'narrative.gathers.head', {
    distance: formatLength(lang, head.distFromDivideM),
    headDistance: formatLength(lang, Math.hypot(head.dxM, head.dyM)),
    direction: compassOf(head.dxM, head.dyM, lang),
  });
}

function joins(s: CatchmentSection, lang: ReportLanguage): string {
  const head = s.geometry.channelHead;
  if (head === null || (head.dxM === 0 && head.dyM === 0)) return t(lang, 'narrative.joins.plain');
  // From the channel head the water runs back towards the outlet.
  return t(lang, 'narrative.joins.toward', { direction: compassOf(-head.dxM, -head.dyM, lang) });
}

function ponds(s: CatchmentSection, lang: ReportLanguage): string | null {
  const list = s.depressions;
  if (list.length === 0) return null;
  const first = list.length === 1 ? t(lang, 'narrative.ponds.one') : t(lang, 'narrative.ponds.many', { count: list.length });
  const on = list.filter((d) => d.onFlowLine).length;
  let second = '';
  if (list.length === 1 && on === 1) second = t(lang, 'narrative.ponds.onChannelOnly');
  else if (on === 1) second = t(lang, 'narrative.ponds.onChannelOne');
  else if (on > 1) second = t(lang, 'narrative.ponds.onChannelMany', { count: on });
  return join(first, second);
}

function leaves(s: CatchmentSection, lang: ReportLanguage): string {
  const first = t(lang, 'narrative.leaves.outlet', { label: s.label });
  const d = s.geometry.downstream;
  const third = d === null || (d.dxM === 0 && d.dyM === 0)
    ? t(lang, 'narrative.leaves.atEdge')
    : t(lang, 'narrative.leaves.downstream', {
      distance: formatLength(lang, d.lengthM),
      direction: compassOf(d.dxM, d.dyM, lang),
    });
  return join(first, third);
}

function isOpen(s: CatchmentSection): boolean {
  const a = s.morph.areaM2;
  return !s.quality.complete || ('value' in a && a.bound === 'minimum');
}

/** The flow story: starts, gathers, joins, ponds (when there are hollows), leaves. */
export function catchmentNarrative(
  section: CatchmentSection,
  lang: ReportLanguage,
  thresholdM2: number = DEFAULT_NETWORK_THRESHOLD_M2,
): readonly NarrativeParagraph[] {
  const out: NarrativeParagraph[] = [
    { lead: 'narrative.lead.starts', text: starts(section, lang) },
    { lead: 'narrative.lead.gathers', text: gathers(section, lang, thresholdM2) },
  ];
  if (hasLines(section)) out.push({ lead: 'narrative.lead.joins', text: joins(section, lang) });
  const pondText = ponds(section, lang);
  if (pondText !== null) out.push({ lead: 'narrative.lead.ponds', text: pondText });
  out.push({ lead: 'narrative.lead.leaves', text: leaves(section, lang) });
  return out;
}


function shapeKey(g: Figure<number>): StringKey | null {
  if (!('value' in g)) return null;
  if (g.value >= RE_NEAR_CIRCULAR_MIN) return 'headline.shape.compact';
  if (g.value >= RE_OVAL_MIN) return 'headline.shape.moderate';
  return 'headline.shape.elongated';
}

/** One line naming the catchment's shape, drainage and area. */
export function headline(section: CatchmentSection, lang: ReportLanguage): string {
  const a = section.morph.areaM2;
  // A withheld area is left out of the headline rather than printed as zero.
  const areaOf = (key: StringKey) => ('value' in a ? t(lang, key, { area: formatArea(lang, a.value) }) : '');
  if (isOpen(section)) return t(lang, 'headline.open', { area: areaOf('headline.ofAtLeast') }).replace(/ +/g, ' ').trim();

  const shape = shapeKey(section.morph.elongation);
  const order = section.network.maxOrder;
  const words: string[] = [];
  if (shape) words.push(t(lang, shape));
  let drainage: string | null = null;
  // Channel order only: soil drainage is not something the scan measures.
  if (order >= 3) drainage = t(lang, 'headline.drain.network', { order: String(order) });
  else if (order === 2) drainage = t(lang, 'headline.drain.branching');
  else if (order === 1) drainage = t(lang, 'headline.drain.single');

  const joined = words.join(t(lang, 'headline.join'));
  const article = t(lang, lang === 'en' && /^[aeiou]/i.test(joined) ? 'headline.an' : 'headline.a');
  const area = areaOf('headline.of');
  const text = drainage === null
    ? t(lang, 'headline.closed', { article, words: joined, area })
    : t(lang, 'headline.closedDrained', { article, words: joined, area, drainage });
  return text.replace(/ +/g, ' ').trim();
}

/** The quality reasons in words, or the all-clear line when there are none. */
export function qualityReasons(quality: CatchmentQuality, lang: ReportLanguage): readonly string[] {
  if (quality.reasons.length === 0) return [t(lang, 'quality.none')];
  return quality.reasons.map((reason) => {
    switch (reason) {
      case 'measured-share-below-0.90':
        return t(lang, 'quality.measured-share-below-0.90', { threshold: formatPercent(lang, SUPPORTED_MEASURED_SHARE, 0) });
      case 'channel-interpolated-over-0.10':
        return t(lang, 'quality.channel-interpolated-over-0.10', { threshold: formatPercent(lang, SUPPORTED_CHANNEL_INTERPOLATED_SHARE, 0) });
      case 'channel-far-interpolated-run':
        return t(lang, 'quality.channel-far-interpolated-run', { cells: MAX_FAR_INTERPOLATED_RUN });
      case 'channel-touches-hole':
        return t(lang, 'quality.channel-touches-hole');
      case 'catchment-open':
        return t(lang, 'quality.catchment-open');
      default:
        throw new RangeError(`watershed narrative: no wording for quality reason ${reason}`);
    }
  });
}
