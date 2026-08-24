/**
 * profileRawFilter.ts
 *
 * Select which of a profile section's accepted returns the raw scatter draws,
 * and report the selection in terms a reader can audit.
 *
 * The section view exists to show the vertical structure the derived series
 * reduces away: the percentile reducer drops known vegetation and building
 * classes and collapses each station to one height, so a scatter that started
 * from the reducer's surviving set could never show the canopy the reducer
 * removed. The default here is therefore every accepted corridor return. The
 * reducer's class exclusions are available as an explicit choice, never as an
 * inherited one.
 *
 * Four scopes narrow what a reader ends up looking at, and the descriptor keeps
 * them apart:
 *
 *   corridor        the capsule membership test the section walk already
 *                   applied; every point here passed it
 *   source          which layer slots contribute
 *   rawAttribute    the class filter this module applies to the scatter
 *   derivedReducer  the percentile series' own class exclusions
 *
 * Conflating them is how a reader comes to believe a filtered scatter is the
 * sampled population. A scatter showing ground class 2 only and a derived
 * series built from a low percentile over everything-but-vegetation are two
 * different subsets of two different pipelines, and a descriptor that reported
 * one "filter" would let either be read as the other.
 *
 * The corridor scope's removal count is null rather than zero: the section
 * carries only the returns the walk accepted, so how many the corridor rejected
 * is not recoverable from it. The derived scope's is null for a different
 * reason: this module never runs the reducer, and a number there would suggest
 * a raw filter had reached the derived series.
 *
 * Pure: returns indices into the section, mutates nothing, reads no DOM.
 */

import { NON_GROUND_CLASSES } from '../../terrain/ground/classificationFilter';
import { profileSectionHas, type ProfileSectionPoints } from './profileSectionBuilder';

/** ASPRS ground. */
export const GROUND_CLASS = 2;

/**
 * The attribute rule applied to the scatter.
 *
 *   all               every return the corridor accepted (the default)
 *   classes           membership in an explicit ASPRS class set
 *   ground            membership in class 2
 *   excludeNonGround  everything except the classes the derived reducer drops,
 *                     reusing that list rather than restating it
 */
export type ProfileRawFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'classes'; readonly classes: readonly number[] }
  | { readonly kind: 'ground' }
  | { readonly kind: 'excludeNonGround' };

/** The rule applied when a request names none: the whole accepted set. */
export const DEFAULT_PROFILE_RAW_FILTER: ProfileRawFilter = { kind: 'all' };

/**
 * A filter request.
 *
 * `slots` is matched against each point's `sourceSlot`, which is the slot the
 * section builder recorded, not the point's position in the section and not the
 * position of the slot in this list. Absent or null leaves the source scope
 * inactive; an empty array is an explicit empty selection and keeps nothing,
 * because reading "no sources chosen" as "all sources" would draw a scatter the
 * caller did not ask for.
 */
export interface ProfileRawFilterRequest {
  readonly filter?: ProfileRawFilter;
  readonly slots?: readonly number[] | null;
}

/** The scopes that can narrow what the scatter shows, in application order. */
export const PROFILE_FILTER_SCOPES = [
  'corridor',
  'source',
  'rawAttribute',
  'derivedReducer',
] as const;

export type ProfileFilterScope = (typeof PROFILE_FILTER_SCOPES)[number];

/** What one scope did to the set that reached it. */
export interface ProfileFilterScopeReport {
  readonly scope: ProfileFilterScope;
  /** Whether this scope narrowed the scatter at all. */
  readonly active: boolean;
  /**
   * Points this scope removed from the set that reached it. Null where the
   * count is not observable from the section: the corridor's rejections are not
   * carried in it, and the derived reducer runs on the other pipeline.
   */
  readonly removed: number | null;
  /** The rule in one clause, for a caption or a report line. */
  readonly rule: string;
}

/**
 * The selection, in numbers a reader can check against the plot.
 *
 * `acceptedCount` is the corridor-accepted population, `keptCount` what the
 * scatter draws, and the two observable scopes account for the difference
 * exactly: keptCount + source.removed + rawAttribute.removed === acceptedCount.
 */
export interface ProfileRawFilterDescriptor {
  readonly acceptedCount: number;
  readonly keptCount: number;
  /** Whether the section carries an index-aligned classification channel. */
  readonly classificationAvailable: boolean;
  /** Points reaching the attribute filter whose classification bit is clear. */
  readonly unclassifiedReaching: number;
  /** How many of those survived it. */
  readonly unclassifiedKept: number;
  /** Removals by the attribute filter, per ASPRS class. Unclassified points are not keyed here. */
  readonly removedByClass: Readonly<Record<number, number>>;
  /** One report per {@link PROFILE_FILTER_SCOPES} entry, in that order. */
  readonly scopes: readonly ProfileFilterScopeReport[];
  /** The subset of scopes that narrowed anything. */
  readonly activeScopes: readonly ProfileFilterScope[];
}

export interface ProfileRawFilterResult {
  /** Ascending indices into the section's shared index space. */
  readonly indices: Uint32Array;
  readonly descriptor: ProfileRawFilterDescriptor;
}

function describeFilter(filter: ProfileRawFilter): string {
  switch (filter.kind) {
    case 'all':
      return 'every return the corridor accepted';
    case 'classes':
      return `ASPRS classes {${[...filter.classes].join(', ')}}`;
    case 'ground':
      return `ASPRS class ${GROUND_CLASS} (ground) only`;
    case 'excludeNonGround':
      return `all but ASPRS classes {${NON_GROUND_CLASSES.join(', ')}}, the list the derived reducer drops`;
  }
}

/**
 * Select the section returns the raw scatter draws.
 *
 * An unclassified point — one whose `classification` presence bit is clear, or
 * any point when the section carries no aligned classification channel — is
 * never read as class 0. Class 0 is a value a source can actually record
 * ("created, never classified"), so treating an absent classification as 0
 * would put points into a class set they were never assigned to.
 *
 * Membership and exclusion therefore resolve it in opposite directions, and
 * both directions follow from the same rule: a classification a point does not
 * carry cannot be evidence for anything.
 *
 *   classes / ground   membership needs positive evidence the point IS in the
 *                      set, so an unclassified point is removed
 *   excludeNonGround   removal needs positive evidence the point IS vegetation,
 *                      building or noise, so an unclassified point is kept,
 *                      matching the derived reducer, which drops only the
 *                      classes it can see
 *
 * With no classification channel at all, a membership filter keeps nothing and
 * `classificationAvailable` is false. The alternative — drawing every point
 * under a "ground only" label — is the one outcome that misleads.
 *
 * The section is read, never written; the result is a fresh array.
 */
export function filterProfileRaw(
  points: ProfileSectionPoints,
  request: ProfileRawFilterRequest = {},
): ProfileRawFilterResult {
  const filter = request.filter ?? DEFAULT_PROFILE_RAW_FILTER;
  const n = points.count;

  const slotFilterActive = request.slots != null;
  const slotSet = slotFilterActive ? new Set(request.slots) : null;

  const cls = points.classification;
  const classificationAvailable = cls != null && cls.length === n;

  const wanted = filter.kind === 'classes' ? new Set(filter.classes) : null;
  const nonGround = filter.kind === 'excludeNonGround' ? new Set(NON_GROUND_CLASSES) : null;

  const kept = new Uint32Array(n);
  let keptCount = 0;
  let sourceRemoved = 0;
  let attributeRemoved = 0;
  let unclassifiedReaching = 0;
  let unclassifiedKept = 0;
  const removedByClass: Record<number, number> = {};

  for (let i = 0; i < n; i++) {
    if (slotSet !== null && !slotSet.has(points.sourceSlot[i]!)) {
      sourceRemoved++;
      continue;
    }

    // Absence of a classification is recorded as null, never as a class value,
    // so no branch below can read it as class 0.
    const classified = classificationAvailable && profileSectionHas(points, i, 'classification');
    const c = classified ? cls![i]! : null;
    if (!classified) unclassifiedReaching++;

    let keep: boolean;
    switch (filter.kind) {
      case 'all':
        keep = true;
        break;
      case 'classes':
        keep = c !== null && wanted!.has(c);
        break;
      case 'ground':
        keep = c === GROUND_CLASS;
        break;
      case 'excludeNonGround':
        keep = c === null || !nonGround!.has(c);
        break;
    }

    if (!keep) {
      attributeRemoved++;
      if (c !== null) removedByClass[c] = (removedByClass[c] ?? 0) + 1;
      continue;
    }
    if (!classified) unclassifiedKept++;
    kept[keptCount++] = i;
  }

  const scopes: ProfileFilterScopeReport[] = [
    {
      scope: 'corridor',
      active: true,
      removed: null,
      rule: 'capsule corridor membership, resolved during the section walk; the section carries only what it accepted',
    },
    {
      scope: 'source',
      active: slotFilterActive,
      removed: sourceRemoved,
      rule: slotFilterActive
        ? `source slots {${[...(request.slots ?? [])].join(', ')}}`
        : 'every source in the section',
    },
    {
      scope: 'rawAttribute',
      active: filter.kind !== 'all',
      removed: attributeRemoved,
      rule: describeFilter(filter),
    },
    {
      scope: 'derivedReducer',
      active: false,
      removed: null,
      rule: 'percentile reducer class exclusions; they shape the derived series and reach no point in this scatter',
    },
  ];

  return {
    indices: kept.slice(0, keptCount),
    descriptor: {
      acceptedCount: n,
      keptCount,
      classificationAvailable,
      unclassifiedReaching,
      unclassifiedKept,
      removedByClass,
      scopes,
      activeScopes: scopes.filter((s) => s.active).map((s) => s.scope),
    },
  };
}

/** The report for one scope, by name. */
export function profileFilterScopeReport(
  descriptor: ProfileRawFilterDescriptor,
  scope: ProfileFilterScope,
): ProfileFilterScopeReport {
  const found = descriptor.scopes.find((s) => s.scope === scope);
  if (!found) throw new Error(`no report for profile filter scope "${scope}"`);
  return found;
}
