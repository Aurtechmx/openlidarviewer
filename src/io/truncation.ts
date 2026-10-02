/**
 * truncation.ts: a source file whose body holds fewer point records than its
 * header declares.
 *
 * The loader keeps what is there and records the shortfall on the cloud's
 * metadata. Every surface that reports coverage reads it through here, so the
 * cloud is called partial with one wording everywhere.
 *
 * Pure: no DOM, no I/O.
 */

/** Records present in the file, and the count the header declares. */
export interface Truncation {
  readonly read: number;
  readonly declared: number;
}

/** The truncation a cloud carries, or null for a complete read. */
export function truncationOf(
  cloud: { readonly metadata?: { readonly truncation?: Truncation } | null } | null | undefined,
): Truncation | null {
  const t = cloud?.metadata?.truncation;
  return t && t.read < t.declared ? t : null;
}

/** Why a whole-dataset result is not claimed on a truncated file. */
export const TRUNCATED_REASON = 'The file is truncated, so only the points read are available and a whole-dataset result is not claimed.';

/** "Truncated: 4 of 2,601 points read". */
export function truncationText(t: Truncation): string {
  return `Truncated: ${t.read.toLocaleString('en-US')} of ${t.declared.toLocaleString('en-US')} points read`;
}

/** The truncation text for a cloud, or undefined for a complete read. */
export function truncationNote(
  cloud: Parameters<typeof truncationOf>[0],
): string | undefined {
  const t = truncationOf(cloud);
  return t ? truncationText(t) : undefined;
}
