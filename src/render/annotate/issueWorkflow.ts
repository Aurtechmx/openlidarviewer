/**
 * issueWorkflow.ts
 *
 * The inspection-issue workflow layered over the annotation model.
 *
 * An issue IS an annotation: the same stable id, the same local/world anchor,
 * the same saved camera view (`cameraState`), the same linked measurement
 * (`linkedMeasurementId`), and the same free text (`note`) carrying the
 * description. What an issue adds is the {@link IssueDetails} block — a
 * severity, an open/resolved status, and the date the condition was observed —
 * held in the optional `Annotation.issue` field. An annotation without that
 * block is a plain annotation, and every helper here treats it as one.
 *
 * The `type: 'issue'` CATEGORY and the workflow block are two different
 * statements. `AnnotationType` drives marker styling and predates this
 * workflow, so saved work can hold `type: 'issue'` annotations that were never
 * triaged. Those stay plain annotations: {@link isIssueAnnotation} asks for the
 * block, never for the category, so nothing already saved acquires a severity
 * or a status it was never given. Attaching the workflow does set the category
 * (see {@link attachIssue}), so the marker matches the workflow from then on.
 *
 * Identity is the annotation's `id` throughout. Nothing here indexes by list
 * position, and the sort below breaks ties on `id` rather than on input order,
 * so a re-sorted or re-imported list ranks identically.
 *
 * Pure data: no DOM, no three.js, unit-tested in Node alongside the session
 * serializer.
 */

import type { Annotation } from './types';

/**
 * How bad the observed condition is, ASCENDING. The array order is the ranking
 * (see {@link issueSeverityRank}); read it, do not restate it.
 */
export const ISSUE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

/** One of the four inspection severities. */
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/**
 * Where the issue stands. Deliberately two states: multi-user comments,
 * assignment and any server-side workflow are out of scope, so there is no
 * "in progress" that nothing can advance and nobody owns.
 */
export const ISSUE_STATUSES = ['open', 'resolved'] as const;

/** Open or resolved. */
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * Severity substituted when a stored value is missing or unrecognised.
 *
 * Mid-rank on purpose. A corrupt file must not silently bury what may have
 * been a critical finding below every asserted `low`, and it must not
 * manufacture urgency the inspector never recorded either.
 */
export const FALLBACK_ISSUE_SEVERITY: IssueSeverity = 'medium';

/**
 * Status substituted when a stored value is missing or unrecognised.
 *
 * Fail-closed: an issue whose status cannot be read is NOT claimed resolved.
 * A stray open issue costs a second look; a fabricated resolution closes a
 * defect that was never fixed.
 */
export const FALLBACK_ISSUE_STATUS: IssueStatus = 'open';

/** The inspection workflow carried by an annotation that is an issue. */
export interface IssueDetails {
  /** How bad the observed condition is. */
  severity: IssueSeverity;
  /** Open or resolved. */
  status: IssueStatus;
  /**
   * When the condition was observed, epoch milliseconds. Distinct from the
   * annotation's `createdAt`: a finding is routinely logged in the office days
   * after the site visit, and a report dates the observation, not the typing.
   * Absent when no date was recorded.
   */
  observedAt?: number;
}

/** The fields a caller supplies to attach the workflow; the rest are filled. */
export interface IssueInput {
  severity: IssueSeverity;
  /** Defaults to `open`. */
  status?: IssueStatus;
  observedAt?: number;
}

/** An annotation that carries the workflow block. */
export type IssueAnnotation = Annotation & { issue: IssueDetails };

/** Per-severity counts, one entry per severity, zeros included. */
export type IssueSeverityCounts = Record<IssueSeverity, number>;

/** A roll-up of the issues in an annotation list. */
export interface IssueSummary {
  /** Annotations carrying the workflow block. Non-issues are not counted. */
  total: number;
  open: number;
  resolved: number;
  /** Counts of the OPEN issues per severity; every severity key is present. */
  openBySeverity: IssueSeverityCounts;
  /**
   * Severity of the most severe OPEN issue. Absent when nothing is open, which
   * a caller must not read as `low` — "nothing outstanding" and "the worst
   * outstanding thing is minor" are different reports.
   */
  highestOpenSeverity?: IssueSeverity;
}

/** Type guard for a valid {@link IssueSeverity}. */
export function isIssueSeverity(v: unknown): v is IssueSeverity {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'critical';
}

/** Type guard for a valid {@link IssueStatus}. */
export function isIssueStatus(v: unknown): v is IssueStatus {
  return v === 'open' || v === 'resolved';
}

/**
 * Rank of a severity: 0 for `low` through 3 for `critical`, so a higher number
 * is a worse condition. Derived from {@link ISSUE_SEVERITIES} so the order is
 * stated once.
 */
export function issueSeverityRank(s: IssueSeverity): number {
  return ISSUE_SEVERITIES.indexOf(s);
}

/**
 * Compare two severities ASCENDING, the `Array.prototype.sort` convention:
 * negative when `a` is less severe than `b`, zero when equal. Sort a roster
 * worst-first by passing the arguments the other way round, as
 * {@link sortIssuesBySeverity} does.
 */
export function compareIssueSeverity(a: IssueSeverity, b: IssueSeverity): number {
  return issueSeverityRank(a) - issueSeverityRank(b);
}

/**
 * Whether an annotation carries the inspection workflow. A `type: 'issue'`
 * annotation with no block is a plain annotation and returns false.
 */
export function isIssueAnnotation(a: Annotation): a is IssueAnnotation {
  return a.issue !== undefined;
}

/** Whether an annotation is an issue AND still open. */
export function isOpenIssue(a: Annotation): boolean {
  return isIssueAnnotation(a) && a.issue.status === 'open';
}

/** Whether an annotation is an issue AND resolved. */
export function isResolvedIssue(a: Annotation): boolean {
  return isIssueAnnotation(a) && a.issue.status === 'resolved';
}

/**
 * Every issue in `list` with the given status, in input order. Annotations
 * that are not issues match NEITHER status and are dropped from both results,
 * so `open.length + resolved.length` counts issues, not annotations.
 */
export function filterIssuesByStatus(
  list: readonly Annotation[],
  status: IssueStatus,
): IssueAnnotation[] {
  return list.filter((a): a is IssueAnnotation => isIssueAnnotation(a) && a.issue.status === status);
}

/** Every issue in `list`, in input order. */
export function issueAnnotations(list: readonly Annotation[]): IssueAnnotation[] {
  return list.filter(isIssueAnnotation);
}

/**
 * The issues in `list`, worst first. Ties break on the observation date
 * (oldest first, falling back to `createdAt` when undated) and then on the
 * stable `id`, so the ranking never depends on where an annotation sat in the
 * input array. Non-issues are dropped. The input is not mutated.
 */
export function sortIssuesBySeverity(list: readonly Annotation[]): IssueAnnotation[] {
  return issueAnnotations(list).sort((a, b) => {
    const bySeverity = compareIssueSeverity(b.issue.severity, a.issue.severity);
    if (bySeverity !== 0) return bySeverity;
    const byDate = (a.issue.observedAt ?? a.createdAt) - (b.issue.observedAt ?? b.createdAt);
    if (byDate !== 0) return byDate;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** A zeroed count for every severity — the starting point of a roll-up. */
function zeroSeverityCounts(): IssueSeverityCounts {
  return { low: 0, medium: 0, high: 0, critical: 0 };
}

/**
 * Count the issues in an annotation list. Plain annotations contribute to
 * nothing, so `total` is the number of issues and not the length of `list`.
 */
export function summarizeIssues(list: readonly Annotation[]): IssueSummary {
  const openBySeverity = zeroSeverityCounts();
  let total = 0;
  let open = 0;
  let resolved = 0;
  let highest: IssueSeverity | undefined;
  for (const a of list) {
    if (!isIssueAnnotation(a)) continue;
    total += 1;
    if (a.issue.status === 'resolved') {
      resolved += 1;
      continue;
    }
    open += 1;
    openBySeverity[a.issue.severity] += 1;
    if (highest === undefined || compareIssueSeverity(a.issue.severity, highest) > 0) {
      highest = a.issue.severity;
    }
  }
  const summary: IssueSummary = { total, open, resolved, openBySeverity };
  if (highest !== undefined) summary.highestOpenSeverity = highest;
  return summary;
}

/** Normalise caller- or file-supplied workflow fields into a stored block. */
function normalizeIssueDetails(severity: unknown, status: unknown, observedAt: unknown) {
  const details: IssueDetails = {
    severity: isIssueSeverity(severity) ? severity : FALLBACK_ISSUE_SEVERITY,
    status: isIssueStatus(status) ? status : FALLBACK_ISSUE_STATUS,
  };
  // A non-finite or non-numeric date is no date. Keeping a NaN here would put
  // an unorderable value into the tiebreak in `sortIssuesBySeverity`.
  if (typeof observedAt === 'number' && Number.isFinite(observedAt)) {
    details.observedAt = observedAt;
  }
  return details;
}

/**
 * Attach (or replace) the inspection workflow on an annotation, returning a
 * NEW annotation with a refreshed `updatedAt`; the original is never mutated,
 * matching `editAnnotation`. The category is set to `issue` so the marker
 * agrees with the workflow. Everything else about the annotation — id, anchor,
 * note, camera view, linked measurement, ownership — is carried through
 * untouched, because an issue is an annotation with more said about it.
 */
export function attachIssue(
  a: Annotation,
  input: IssueInput,
  now: number = Date.now(),
): IssueAnnotation {
  return {
    ...a,
    type: 'issue',
    updatedAt: now,
    issue: normalizeIssueDetails(input.severity, input.status, input.observedAt),
  };
}

/**
 * Move an issue between open and resolved, returning a NEW annotation with a
 * refreshed `updatedAt`.
 *
 * An annotation that is not an issue, and an issue already in `status`, are
 * both returned AS THE SAME OBJECT: there is no workflow step to record, so
 * there is no edit to timestamp. Callers can test that by identity.
 */
export function setIssueStatus(
  a: Annotation,
  status: IssueStatus,
  now: number = Date.now(),
): Annotation {
  if (!isIssueAnnotation(a)) return a;
  if (a.issue.status === status) return a;
  return { ...a, updatedAt: now, issue: { ...a.issue, status } };
}

/**
 * Read a persisted workflow block defensively.
 *
 * Returns undefined when the field is absent or is not an object, which is how
 * an annotation saved before this workflow existed stays a plain annotation.
 * When the block IS there, an unrecognised severity or status degrades to the
 * documented fallback rather than throwing or dropping the whole block: losing
 * the block would demote a real finding to an untracked note, which is a worse
 * failure than a mid-rank severity on a corrupt record.
 */
export function parseIssueDetails(v: unknown): IssueDetails | undefined {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const raw = v as Record<string, unknown>;
  return normalizeIssueDetails(raw.severity, raw.status, raw.observedAt);
}
