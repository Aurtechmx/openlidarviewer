/**
 * profileExportDraft.ts: what was typed in the profile export dialog and not
 * exported, and the paper last exported on.
 *
 * Held in this tab's memory only, against the measurement itself: closing the
 * scan or importing a session replaces or drops the measurement, and the draft
 * goes with it. Never written to the measurement, a session file, storage or
 * the company details. Only what the user changed is held, so a field they left
 * alone shows its current value when the dialog opens again.
 */
import type { ProfilePaper } from '../render/measure/profilePdf';

type Unit = 'metric' | 'imperial' | 'unverified';

interface Draft {
  readonly scanName: string | null;
  readonly unit: Unit;
  readonly values: Readonly<Record<string, string>>;
  readonly rows: Readonly<Record<string, string[][]>>;
  /** Present when the logo was changed; `url` is undefined when it was removed. */
  readonly logo?: { readonly url: string | undefined };
}

const drafts = new WeakMap<object, Draft>();

/** The dialog's fields as the draft reads and writes them. */
export interface DraftForm {
  readonly scanName: string | null;
  readonly unit: Unit;
  readonly boxes: Readonly<Record<string, { value: string }>>;
  readonly rows: Readonly<Record<string, { rows(): string[][]; set(v: readonly string[][]): void }>>;
  readonly logo: { get(): string | undefined; set(url: string | undefined): void };
  /** A chainage typed in `unit`, in metres of the line; null when it is not one. */
  readonly parse: (raw: string, unit: Unit) => number | null;
  /** Metres of the line as the dialog shows them. */
  readonly show: (m: number) => string;
  readonly unitLabel: string;
}

export interface OpenDraft {
  /** What to say about the details put back, or null when there were none. */
  readonly said: string | null;
  /** The boxes, rows and logo that were put back, by key. */
  readonly restored: readonly string[];
  /** Hold what was changed, or nothing when nothing was. */
  keep(): void;
  /** Forget it. */
  drop(): void;
  /** Forget it and put every field back as it was without it. */
  discard(): void;
}

const filled = (rows: readonly string[][]): string[][] => rows.filter((r) => r.some((c) => c.trim() !== ''));
const same = (a: readonly string[][], b: readonly string[][]): boolean => JSON.stringify(filled(a)) === JSON.stringify(filled(b));

/** Marks typed in another unit, in the one now shown, and what was done to them. A chainage that cannot be converted is left empty. */
function marksNow(marks: readonly string[][], from: Unit, f: DraftForm): { marks: string[][]; said: string } {
  let lost = false;
  const out = filled(marks).map(([raw = '', ...rest]) => {
    const m = from === 'unverified' || f.unit === 'unverified' ? null : f.parse(raw, from);
    if (m === null && raw.trim() !== '') lost = true;
    return [m === null ? '' : f.show(m), ...rest];
  });
  return {
    marks: out,
    said: lost ? `The unit changed, so chainages that could not be converted were left out. Type them again in ${f.unitLabel}.` : `The unit changed, so the marked points were converted to ${f.unitLabel}.`,
  };
}

/** Put back what was left unexported for `owner`. Call once the form holds its own values and before the user can touch it. */
export function openProfileDraft(owner: object | undefined, f: DraftForm): OpenDraft {
  const seedValues = Object.fromEntries(Object.entries(f.boxes).map(([k, b]) => [k, b.value]));
  const seedRows = Object.fromEntries(Object.entries(f.rows).map(([k, r]) => [k, r.rows()]));
  const seedLogo = f.logo.get();
  const drop = (): void => { if (owner) drafts.delete(owner); };
  const put = (d: Pick<Draft, 'values' | 'rows'>): void => {
    for (const [k, v] of Object.entries(d.values)) f.boxes[k]!.value = v;
    for (const [k, v] of Object.entries(d.rows)) f.rows[k]!.set(v);
  };

  const held = owner && drafts.get(owner);
  // Work on another scan's line is not this one's.
  const d = held && held.scanName === f.scanName ? held : undefined;
  if (held && !d) drop();
  const restored: string[] = [];
  let said: string | null = null;
  if (d) {
    said = 'Unexported details from last time.';
    const values = { ...d.values }, rows = { ...d.rows };
    if (d.unit !== f.unit) {
      delete values.units;
      if (rows.marks && filled(rows.marks).length > 0) {
        const now = marksNow(rows.marks, d.unit, f);
        rows.marks = now.marks;
        said += ` ${now.said}`;
      }
    }
    put({ values, rows });
    restored.push(...Object.keys(values), ...Object.keys(rows));
    if (d.logo) { f.logo.set(d.logo.url); restored.push('logo'); }
    if (restored.length === 0) said = null;
  }

  return {
    said, restored, drop,
    keep: () => {
      if (!owner) return;
      const values = Object.fromEntries(Object.entries(f.boxes).flatMap(([k, b]) => (b.value === seedValues[k] ? [] : [[k, b.value]])));
      const rows = Object.fromEntries(Object.entries(f.rows).flatMap(([k, r]) => (same(r.rows(), seedRows[k]!) ? [] : [[k, filled(r.rows())]])));
      const url = f.logo.get();
      const logo = url === seedLogo ? undefined : { url };
      if (Object.keys(values).length + Object.keys(rows).length === 0 && !logo) drop();
      else drafts.set(owner, { scanName: f.scanName, unit: f.unit, values, rows, ...(logo ? { logo } : {}) });
    },
    discard: () => {
      drop();
      put({ values: seedValues, rows: seedRows });
      f.logo.set(seedLogo);
    },
  };
}

// ── paper ──────────────────────────────────────────────────────────────────
let paper: ProfilePaper = 'a3';

/** The paper the last profile of this session was exported on. */
export const lastProfilePaper = (): ProfilePaper => paper;
export function setLastProfilePaper(p: ProfilePaper): void { paper = p; }
