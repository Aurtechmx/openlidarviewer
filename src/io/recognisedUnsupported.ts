/**
 * recognisedUnsupported.ts
 *
 * Formats OpenLiDARViewer can NAME but cannot read. A file of one of these
 * kinds would otherwise fall through to the generic "not recognised" report,
 * which tells the user nothing useful. Naming it lets the open path say what
 * the file is and how to get a readable copy.
 *
 * This is deliberately NOT a `SourceFormat`: nothing here is decodable, so no
 * loader, no format info and no supported-format count includes it. The open
 * path checks this before any loader runs and stops with the message.
 *
 * Pure — no DOM, no loaders — and it reads only the first few bytes it is given.
 */

import { sniffFormat } from './sniffFormat';

/** A format that is recognised but cannot be opened. */
export type RecognisedUnsupportedFormat = 'rcs' | 'rcp';

/** The typed outcome of recognising a file OLV cannot open. */
export interface RecognisedUnsupported {
  readonly kind: 'recognised-unsupported';
  readonly format: RecognisedUnsupportedFormat;
  /** Human name of the format, e.g. "Autodesk ReCap scan (.rcs)". */
  readonly name: string;
  /** Short heading for the open-error message. */
  readonly title: string;
  /** What the user can do instead. */
  readonly remedy: string;
}

/** Autodesk ReCap RCS files open with these five ASCII bytes. */
export const RCS_MAGIC = 'ADOCT';

/** How many leading bytes recognition reads. */
export const RECOGNISE_BYTES = RCS_MAGIC.length;

const RCS: RecognisedUnsupported = {
  kind: 'recognised-unsupported',
  format: 'rcs',
  name: 'Autodesk ReCap scan (.rcs)',
  title: 'Autodesk ReCap scan (.rcs) — not supported yet',
  remedy:
    "OpenLiDARViewer can't read ReCap's RCS format yet. In Autodesk ReCap, export the " +
    'scan as E57 or LAS, then open that file here.',
};

const RCP: RecognisedUnsupported = {
  kind: 'recognised-unsupported',
  format: 'rcp',
  name: 'Autodesk ReCap project (.rcp)',
  title: 'Autodesk ReCap project (.rcp) — not supported yet',
  remedy:
    "This is a ReCap project file. It points to .rcs scans, which OpenLiDARViewer can't " +
    'read yet. Export the scans from ReCap as E57 or LAS.',
};

function startsWithRcsMagic(head: ArrayBuffer): boolean {
  if (head.byteLength < RECOGNISE_BYTES) return false;
  const bytes = new Uint8Array(head, 0, RECOGNISE_BYTES);
  for (let i = 0; i < RECOGNISE_BYTES; i++) {
    if (bytes[i] !== RCS_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * Recognise a file OLV can name but not open, or return `null`.
 *
 * - RCS is recognised by content: the `ADOCT` magic, whatever the extension.
 *   A `.rcs` name without the magic is not claimed, so it gets the normal
 *   unknown-format handling.
 * - RCP is recognised by the `.rcp` extension, unless the bytes are a format
 *   OLV reads, in which case the content wins.
 */
export function recogniseUnsupported(
  head: ArrayBuffer,
  filename: string,
): RecognisedUnsupported | null {
  if (startsWithRcsMagic(head)) return RCS;
  if (extensionOf(filename) === 'rcp' && sniffFormat(head, filename) === 'unknown') return RCP;
  return null;
}

/** The single line the open-error toast shows for a recognised format. */
export function recognisedUnsupportedMessage(r: RecognisedUnsupported): string {
  return `${r.title}. ${r.remedy}`;
}
