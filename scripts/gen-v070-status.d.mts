/**
 * Types for the importable surface of `gen-v070-status.mjs`.
 *
 * The generator is plain ESM (it runs under bare `node` in the gate), but the
 * parse and the render are pure functions tested against constructed ledgers
 * rather than the real file, so their shapes are declared here. The CLI body
 * is guarded behind `isCliEntry`, which is what keeps importing this module
 * from rewriting the tracked document.
 */

/** One account of an entry: the verdict and the area it belongs to. */
export interface LedgerAccount {
  readonly status: string;
  readonly category: string;
}

export interface CurrentStatus {
  /** The last account of each entry, keyed by id. */
  readonly latest: ReadonlyMap<string, LedgerAccount>;
  /** How many accounts an entry has, for the entries that have more than one. */
  readonly revisited: ReadonlyMap<string, number>;
}

/**
 * Read every entry's latest account.
 *
 * Throws when a heading the ledger carries does not parse, rather than
 * omitting it: a silently short index is the defect this guards.
 */
export function readCurrentStatus(text?: string): CurrentStatus;

/** The status document, derived entirely from the parsed ledger. */
export function renderStatus(status: CurrentStatus): string;

/** A summary-table row whose Status column disagrees with the entry's latest account. */
export interface StaleSummaryRow {
  readonly id: string;
  /** The status the summary table shows. */
  readonly table: string;
  /** The latest account's status, or null when the ledger has no account of the id. */
  readonly latest: string | null;
}

/** Rows of the table above the first entry heading that disagree with `latest`. */
export function staleSummaryRows(
  text: string,
  latest: ReadonlyMap<string, LedgerAccount>,
): StaleSummaryRow[];

/** One Totals line that disagrees with the summary table. */
export interface StaleTotal {
  /** The status named on the line, or `total`. */
  readonly status: string;
  /** The count the Totals block states, or null when it has no line for it. */
  readonly stated: number | null;
  /** The count the summary table's rows give. */
  readonly rows: number;
}

/** Totals lines that disagree with the summary table above the first entry heading. */
export function staleTotals(text: string): StaleTotal[];
