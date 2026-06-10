/**
 * safeStorage.ts
 *
 * Guarded `localStorage` access, extracted from the pattern `themes.ts`
 * established. Bare `localStorage.getItem` / `setItem` calls are not safe
 * in every environment the viewer runs in: the global can be entirely
 * undefined (Node tests), the *access itself* can throw (sandboxed or
 * cross-origin iframes — the embed path — and some privacy modes), and a
 * `setItem` can throw on quota. Persistence is always a nice-to-have here
 * (a panel width, a theme, a chart height), so a storage failure must
 * degrade to "the preference just doesn't persist this session" — never
 * to a crash in a constructor or an event handler.
 *
 * Read errors return `null` silently; write errors are swallowed. The
 * localStorage API is the user's surface, not ours — never throw on a
 * missing, malformed, or inaccessible value.
 *
 * Callers that need richer behaviour (JSON envelopes, suppression
 * latches, one-shot warnings) keep their own guarded wrappers
 * (`prefs.ts`, `CrsOverrideStore.ts`, `usageCounters.ts`); this helper
 * is for the simple string-in / string-out call sites.
 */

/** Read a value. Returns `null` when absent OR when storage is unavailable. */
export function storageGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Write a value. Best-effort — silently swallows any storage error
 * (quota, security, privacy mode). Never throws.
 */
export function storageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // Best-effort persistence; ignore quota / security failures.
  }
}
