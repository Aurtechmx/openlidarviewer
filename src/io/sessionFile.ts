/**
 * sessionFile.ts
 *
 * The tiny, eager half of the session module: just "is this file a session?".
 * Kept separate from the (large) `session.ts` serializer/parser so the single
 * file router in `handleFile` — which runs on every dropped/opened file — can
 * answer that question without pulling the whole parser into the initial
 * bundle. The serializer/parser is dynamically imported only when the user
 * actually exports or opens a session.
 */

/** The canonical inspection-session file extension (JSON content inside). */
export const SESSION_EXTENSION = '.olvsession';

/**
 * True when a file is an inspection session (a saved analysis) rather than a
 * point-cloud scan. The single detector every entry point uses to route a
 * dropped/opened file to the session loader vs the cloud loader.
 */
export function isSessionFile(name: string): boolean {
  return name.toLowerCase().endsWith(SESSION_EXTENSION);
}
