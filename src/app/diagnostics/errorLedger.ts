/**
 * errorLedger.ts
 *
 * A bounded, session-local record of the failures a user could report. Each
 * entry holds only short tokens (subsystem, code, action) and a time relative to
 * page load. Free text never leaves: every field is reduced to a plain token on
 * the way in and again on the way out, so a message carrying a file path, a URL
 * or a coordinate cannot reach a copied diagnostics report. No DOM, no Viewer.
 *
 * The buffer lives on `globalThis` so the startup shell's error capture
 * (`captureWindowErrors` in app/staleChunkReload.ts, kept tiny and free of this module) and the lazily loaded
 * readers share it without this module riding the startup chunk.
 */

export interface ErrorLedgerEntry {
  /** Milliseconds since the page loaded. */
  readonly t: number;
  readonly subsystem: string;
  readonly code: string;
  readonly recoverable: boolean;
  readonly action: string;
}

export const ERROR_LEDGER_CAP = 50;

/** The shared buffer key; `captureWindowErrors` in app/staleChunkReload.ts writes the same one. */
export const ERROR_LEDGER_KEY = '__olvErrorLedger';

/** A `captureWindowErrors` tuple: [ms since load, 0 = uncaught error | 1 = unhandled rejection, class name or 0]. */
type CapturedTuple = readonly [number, number, unknown];

const buffer = (): Array<ErrorLedgerEntry | CapturedTuple> =>
  ((globalThis as Record<string, unknown>)[ERROR_LEDGER_KEY] ??= []) as Array<ErrorLedgerEntry | CapturedTuple>;

function fromTuple([t, kind, name]: CapturedTuple): ErrorLedgerEntry {
  const rejection = kind === 1;
  return {
    t: Number(t),
    subsystem: rejection ? 'promise' : 'window',
    code: typeof name === 'string' ? name : 'non-error',
    recoverable: true,
    action: rejection ? 'none' : 'reload-if-stuck',
  };
}

const TOKEN = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;

/** A field reduced to a plain token, or `other`. */
export const ledgerToken = (value: unknown): string =>
  typeof value === 'string' && TOKEN.test(value) ? value : 'other';

/** The error class name (`TypeError`, `AbortError`), never its message. */
export const errorCode = (value: unknown): string =>
  ledgerToken(value instanceof Error ? value.name : typeof value === 'object' && value ? 'object' : typeof value);

export function recordError(subsystem: string, code: string, recoverable: boolean, action = 'none', now = performance.now()): void {
  const entries = buffer();
  entries.push({ t: Math.round(now), subsystem: ledgerToken(subsystem), code: ledgerToken(code), recoverable, action: ledgerToken(action) });
  if (entries.length > ERROR_LEDGER_CAP) entries.splice(0, entries.length - ERROR_LEDGER_CAP);
}

/** The newest entries, oldest first, every field re-sanitized. */
export const errorLedgerSnapshot = (): ErrorLedgerEntry[] =>
  buffer().slice(-ERROR_LEDGER_CAP).map((raw) => (Array.isArray(raw) ? fromTuple(raw as CapturedTuple) : raw as ErrorLedgerEntry)).map((e) => ({
    t: Math.round(Number(e.t) || 0),
    subsystem: ledgerToken(e.subsystem),
    code: ledgerToken(e.code),
    recoverable: e.recoverable === true,
    action: ledgerToken(e.action),
  }));

export function clearErrorLedger(): void {
  buffer().length = 0;
}
