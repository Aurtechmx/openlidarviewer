/**
 * deliverableFields.ts: what the person exporting a drawing adds to it.
 *
 * Three groups with three lives:
 *   - who they are (company, logo, people): remembered on this device only when
 *     they ask for it, and never written to a session file;
 *   - the job (project, client, place, status, date): kept for the session and
 *     saved in the session file, shared by every profile;
 *   - one profile's own words (title, drawing number, end names, marked points,
 *     notes, issues): kept on that measurement, so they follow it through a
 *     session.
 *
 * Text is the user's and is printed as typed, never translated. Every reader
 * of it, from a form, a session file or storage, goes through a sanitiser here:
 * control and direction characters are dropped, lengths and counts are capped.
 * None of it can change or remove a measured figure, a source or a caveat.
 *
 * Pure apart from the module's own job and company state.
 */

export const DELIVERABLE_STATUSES = ['preliminary', 'review', 'issued'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

export interface CompanyDetails {
  readonly company?: string;
  /** PNG or JPEG data URL. */
  readonly logoDataUrl?: string;
  readonly preparedBy?: string;
  readonly checkedBy?: string;
  readonly approvedBy?: string;
}

export interface JobDetails {
  readonly project?: string;
  readonly client?: string;
  readonly location?: string;
  readonly date?: string;
  readonly status?: DeliverableStatus;
}

export interface IssueRow {
  readonly issue: string;
  readonly description: string;
  readonly date: string;
  readonly by: string;
  readonly checked: string;
}

/** A point the user names on the line. */
export interface MarkedPoint {
  /** Distance along the line, metres (source units when the unit is unverified). */
  readonly chainage: number;
  readonly text: string;
}

export interface ProfileSheetFields {
  readonly title?: string;
  readonly subtitle?: string;
  readonly drawingNo?: string;
  readonly revision?: string;
  readonly endA?: string;
  readonly endB?: string;
  readonly notes?: string;
  readonly issues?: readonly IssueRow[];
  readonly marks?: readonly MarkedPoint[];
}

/** Everything the user adds to one profile set. */
export interface ProfileDeliverable extends CompanyDetails, JobDetails, ProfileSheetFields {}

/** Longest a field may be, characters. */
export const FIELD_LIMITS = {
  title: 90, subtitle: 140, project: 120, client: 120, location: 120, company: 90,
  preparedBy: 80, checkedBy: 80, approvedBy: 80, drawingNo: 40, revision: 12, date: 30,
  endA: 40, endB: 40, notes: 1200, issue: 8, issueDescription: 110, issueBy: 24, mark: 60,
} as const;
export const MAX_ISSUES = 6;
export const MAX_MARKS = 8;
/** Largest logo, characters of data URL (about 500 kB of image). */
export const MAX_LOGO_CHARS = 700_000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** One line of user text, or undefined when nothing is left of it. */
export function cleanLine(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = [...v.replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim()].slice(0, max).join('').trim();
  return s === '' ? undefined : s;
}

/** Several lines of user text, or undefined. Blank lines at the ends go; at most one is kept between paragraphs. */
export function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = [...v.replace(/\r\n?|\u2028|\u2029/g, '\n').replace(/\t/g, ' ').replace(CONTROL, '').replace(/\n{3,}/g, '\n\n').trim()].slice(0, max).join('').trim();
  return s === '' ? undefined : s;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Drop the undefined entries, so an empty group is an empty object. */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as T;
}

/** A PNG or JPEG data URL of acceptable size whose bytes start as that format does. */
export function cleanLogo(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length > MAX_LOGO_CHARS) return undefined;
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return undefined;
  return (m[1] === 'png' ? m[2]!.startsWith('iVBORw0KGgo') : m[2]!.startsWith('/9j/')) ? v : undefined;
}

export function cleanCompany(v: unknown): CompanyDetails {
  if (!isRecord(v)) return {};
  return compact({
    company: cleanLine(v.company, FIELD_LIMITS.company), logoDataUrl: cleanLogo(v.logoDataUrl),
    preparedBy: cleanLine(v.preparedBy, FIELD_LIMITS.preparedBy), checkedBy: cleanLine(v.checkedBy, FIELD_LIMITS.checkedBy),
    approvedBy: cleanLine(v.approvedBy, FIELD_LIMITS.approvedBy),
  });
}

export function cleanJob(v: unknown): JobDetails {
  if (!isRecord(v)) return {};
  return compact({
    project: cleanLine(v.project, FIELD_LIMITS.project), client: cleanLine(v.client, FIELD_LIMITS.client),
    location: cleanLine(v.location, FIELD_LIMITS.location), date: cleanLine(v.date, FIELD_LIMITS.date),
    // Preliminary is what a sheet says unasked, so it is not stored.
    status: v.status === 'review' || v.status === 'issued' ? v.status : undefined,
  });
}

export function cleanProfileFields(v: unknown): ProfileSheetFields {
  if (!isRecord(v)) return {};
  const issues = (Array.isArray(v.issues) ? v.issues : []).slice(0, MAX_ISSUES).flatMap((r): IssueRow[] => {
    if (!isRecord(r)) return [];
    const row = {
      issue: cleanLine(r.issue, FIELD_LIMITS.issue) ?? '', description: cleanLine(r.description, FIELD_LIMITS.issueDescription) ?? '',
      date: cleanLine(r.date, FIELD_LIMITS.date) ?? '', by: cleanLine(r.by, FIELD_LIMITS.issueBy) ?? '', checked: cleanLine(r.checked, FIELD_LIMITS.issueBy) ?? '',
    };
    return Object.values(row).some((x) => x !== '') ? [row] : [];
  });
  const marks = (Array.isArray(v.marks) ? v.marks : []).flatMap((r): MarkedPoint[] => {
    if (!isRecord(r) || typeof r.chainage !== 'number' || !Number.isFinite(r.chainage) || r.chainage < 0) return [];
    const text = cleanLine(r.text, FIELD_LIMITS.mark);
    return text ? [{ chainage: r.chainage, text }] : [];
  }).slice(0, MAX_MARKS).sort((a, b) => a.chainage - b.chainage);
  return compact({
    title: cleanLine(v.title, FIELD_LIMITS.title), subtitle: cleanLine(v.subtitle, FIELD_LIMITS.subtitle),
    drawingNo: cleanLine(v.drawingNo, FIELD_LIMITS.drawingNo), revision: cleanLine(v.revision, FIELD_LIMITS.revision),
    endA: cleanLine(v.endA, FIELD_LIMITS.endA), endB: cleanLine(v.endB, FIELD_LIMITS.endB),
    notes: cleanText(v.notes, FIELD_LIMITS.notes),
    issues: issues.length > 0 ? issues : undefined, marks: marks.length > 0 ? marks : undefined,
  });
}

/** True when the group holds nothing. */
export const isEmptyFields = (o: object): boolean => Object.keys(o).length === 0;

// ── this tab's job and company ─────────────────────────────────────────────
let job: JobDetails = {};
let company: CompanyDetails = {};

export const jobDetails = (): JobDetails => job;
export function setJobDetails(v: unknown): void { job = cleanJob(v); }
export const companyDetails = (): CompanyDetails => company;
export function setCompanyDetails(v: unknown): void { company = cleanCompany(v); }
