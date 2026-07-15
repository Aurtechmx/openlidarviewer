/**
 * loadErrors.ts
 *
 * Maps a load failure — from any stage of the pipeline — to a clear,
 * categorised, user-facing message. No cryptic stack trace ever reaches the
 * toast; the raw error still goes to the console under `?debug=1`.
 *
 * The pipeline throws a typed {@link LoadError} where it knows the category
 * itself (an unsupported format, say). Errors that arrive untyped — a worker
 * decode failure, a third-party loader's throw — are classified best-effort
 * from their message text. {@link LoadError} is the clean seam: a v0.3 loader
 * that throws it with a precise category is described precisely, with no change
 * here.
 *
 * Pure — no DOM, no three.js — unit-tested in Node.
 */

/** The category a load failure falls into — drives the user-facing message. */
export type LoadErrorCategory =
  | 'unsupported-format'
  | 'malformed-file'
  | 'memory-constraint'
  | 'gpu-limitation'
  | 'decode-failure'
  | 'resource-load';

/** A load failure tagged with its category, so the UI can explain it clearly. */
export class LoadError extends Error {
  readonly category: LoadErrorCategory;
  constructor(category: LoadErrorCategory, message: string) {
    super(message);
    this.name = 'LoadError';
    this.category = category;
  }
}

/** The clear, user-facing message for each failure category. */
const CATEGORY_MESSAGE: Record<LoadErrorCategory, string> = {
  'unsupported-format': "This file type isn't supported yet.",
  'malformed-file': 'This file could not be read — it may be malformed or incomplete.',
  'memory-constraint': "This file is too large for this device's memory.",
  'gpu-limitation':
    "This scan exceeds what this device's GPU can display; it was reduced.",
  'decode-failure': 'Decoding failed — the file may be corrupt or truncated.',
  'resource-load':
    'Part of the viewer could not be loaded. Check your connection and reload the page.',
};

/** The user-facing message for a known failure category. */
export function messageForCategory(category: LoadErrorCategory): string {
  return CATEGORY_MESSAGE[category];
}

/**
 * Best-effort classification of an untyped error from its message text — the
 * fallback for failures that did not arrive as a typed {@link LoadError}.
 */
export function classifyLoadError(message: string): LoadErrorCategory {
  const m = message.toLowerCase();
  // A failed code-chunk fetch — not a problem with the file. Browsers phrase
  // it as "failed to fetch dynamically imported module" (Chromium), "error
  // loading dynamically imported module" (Firefox), "importing a module
  // script failed" (Safari), or "loading chunk … failed"; Vite's module
  // preloader phrases a failed preload as "unable to preload CSS/…".
  if (
    m.includes('dynamically imported module') ||
    m.includes('importing a module script') ||
    m.includes('loading chunk') ||
    m.includes('unable to preload')
  ) {
    return 'resource-load';
  }
  if (
    m.includes('unrecognised') ||
    m.includes('unrecognized') ||
    m.includes('unsupported') ||
    m.includes('not supported')
  ) {
    return 'unsupported-format';
  }
  if (m.includes('memory') || m.includes('allocation') || m.includes('heap')) {
    return 'memory-constraint';
  }
  if (
    m.includes('header') ||
    m.includes('malformed') ||
    m.includes('invalid') ||
    m.includes('empty') ||
    m.includes('no points')
  ) {
    return 'malformed-file';
  }
  return 'decode-failure';
}

/**
 * Map any thrown value to a clear, user-facing load-failure message. A typed
 * {@link LoadError} carries its own category; anything else is classified from
 * its message text. Never throws, and never returns an empty string.
 */
export function describeLoadError(error: unknown): string {
  if (error instanceof LoadError) return messageForCategory(error.category);
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return messageForCategory('decode-failure');
  return messageForCategory(classifyLoadError(message));
}
