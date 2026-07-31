/**
 * consent.ts
 *
 * The session consent state machine for remote basemap tile fetching.
 * OpenLiDARViewer is local-first: it must not touch the network for map tiles
 * until the user explicitly grants it, per session. This module is the single
 * gate — the tile-fetching UI adapter asks `networkPermitted()` and fetches
 * nothing unless it answers true, which it does ONLY in the 'granted' state.
 *
 * `parse` is deliberately paranoid: it tolerates any garbage (returning
 * 'unasked') and will only ever produce 'granted' from the exact serialized
 * 'granted' string. Corrupt or forged persisted state can therefore never
 * mint consent — the worst a bad payload can do is make us ask again.
 *
 * Pure state, no storage: persistence (if any) is the caller's job via
 * serialize()/parseContextConsent().
 */

/** The three consent states. 'unasked' is the only default. */
export type ContextConsent = 'unasked' | 'granted' | 'denied';

/** The mutable session consent holder returned by {@link createConsentState}. */
export interface ConsentState {
  /** Current consent value. */
  readonly get: () => ContextConsent;
  /** Record an explicit user grant. */
  readonly grant: () => void;
  /** Record an explicit user denial. */
  readonly deny: () => void;
  /** Forget the decision (e.g. provider changed); back to 'unasked'. */
  readonly reset: () => void;
  /** True ONLY when consent is 'granted' — the sole network gate. */
  readonly networkPermitted: () => boolean;
  /** Serialize the current state for the caller's persistence layer. */
  readonly serialize: () => string;
}

/** Create a fresh session consent state, starting at 'unasked'. */
export function createConsentState(): ConsentState {
  let value: ContextConsent = 'unasked';
  return {
    get: () => value,
    grant: () => {
      value = 'granted';
    },
    deny: () => {
      value = 'denied';
    },
    reset: () => {
      value = 'unasked';
    },
    networkPermitted: () => value === 'granted',
    serialize: () => value,
  };
}

/**
 * Parse a persisted consent value. Anything that is not exactly 'granted' or
 * 'denied' — wrong type, wrong case, whitespace, JSON blobs, undefined —
 * collapses to 'unasked'. In particular, 'granted' can ONLY come from the
 * exact string 'granted': consent is never minted from corrupt input.
 */
export function parseContextConsent(raw: unknown): ContextConsent {
  if (raw === 'granted') return 'granted';
  if (raw === 'denied') return 'denied';
  return 'unasked';
}
