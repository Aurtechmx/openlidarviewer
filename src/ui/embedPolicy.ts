/**
 * embedPolicy.ts
 *
 * Who may frame the viewer and drive it through the embed bridge.
 *
 * The page that frames the viewer chooses the viewer's URL, so nothing in the
 * URL can authorise that page: `?embedParent=` and `?embedOrigins=` are only a
 * REQUEST. A parent is trusted when it is
 *
 *   - this page's own origin, or
 *   - on the deployer's allow-list, a build-time constant (`OLV_EMBED_ORIGINS`,
 *     empty by default) that a visitor's URL cannot change.
 *
 * The URL may narrow the deployer's list to the origins a given embed wants. It
 * can never add to it. Where the browser reports the framing origin
 * (`location.ancestorOrigins`), the decision is made on that origin; elsewhere
 * a same-origin parent is detected by reading its location, and a cross-origin
 * parent is left to the origin check on each message.
 *
 * When the page is framed and no rule matches it runs in safe mode: the bridge
 * is off and the app shows a notice instead of its interface.
 *
 * Pure: the browser reads live in {@link readFrameFacts}.
 */

/** What is known about how this page is framed. */
export interface FrameFacts {
  /** `window.top !== window`. */
  readonly framed: boolean;
  /** This page's own origin. */
  readonly ownOrigin: string;
  /**
   * `location.ancestorOrigins`, immediate parent first, when the browser
   * provides it (Chromium and WebKit do; Firefox does not).
   */
  readonly ancestorOrigins: readonly string[] | undefined;
  /** The parent's location could be read, which only a same-origin parent allows. */
  readonly parentSameOrigin: boolean;
}

/** The rules a framing parent is held to. */
export interface FrameRules {
  /** The deployer's allow-list (build-time). Empty by default. */
  readonly deployerOrigins: readonly string[];
  /** Origins the viewer URL asks for; narrows the deployer's list, never extends it. */
  readonly requestedOrigins?: readonly string[];
}

/** What the page does about its framing. */
export type FrameDecision =
  /** Not framed. The bridge has no parent to talk to. */
  | { readonly kind: 'top'; readonly origins: readonly string[] }
  /** Framed by a parent the rules accept. `origins` are the only origins the bridge talks to. */
  | { readonly kind: 'bridge'; readonly origins: readonly string[]; readonly parentVerified: boolean }
  /** Framed and nothing authorises it: bridge off, interface withheld. */
  | { readonly kind: 'safe'; readonly reason: string };

/**
 * The origin of an http(s) URL, or null for `*`, an opaque origin or anything
 * that does not parse.
 */
export function toOrigin(s: string): string | null {
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** Parse a comma-separated origin list, dropping anything that is not an http(s) origin. */
export function parseOriginList(raw: string): string[] {
  return [...new Set(raw.split(',').map(toOrigin).filter((o): o is string => o !== null))];
}

/** The deployer's allow-list, from the build-time constant `__OLV_EMBED_ORIGINS__`. */
export function deployerEmbedOrigins(): readonly string[] {
  return typeof __OLV_EMBED_ORIGINS__ === 'string' ? parseOriginList(__OLV_EMBED_ORIGINS__) : [];
}

/** Decide what a page with these facts does under these rules. */
export function decideFramePolicy(facts: FrameFacts, rules: FrameRules): FrameDecision {
  if (!facts.framed) return { kind: 'top', origins: [facts.ownOrigin] };

  // The URL narrows the deployer's list. An origin it names that is not on the
  // list is dropped: whoever framed the page wrote that URL.
  const cross = rules.requestedOrigins
    ? rules.requestedOrigins.filter((o) => rules.deployerOrigins.includes(o))
    : [...rules.deployerOrigins];
  const trusted = [facts.ownOrigin, ...cross.filter((o) => o !== facts.ownOrigin)];

  const parent = facts.ancestorOrigins?.[0];
  if (parent !== undefined) {
    return trusted.includes(parent)
      ? { kind: 'bridge', origins: [parent], parentVerified: true }
      : { kind: 'safe', reason: `framed by ${parent}, which is not an allowed embedding origin` };
  }
  if (facts.parentSameOrigin) return { kind: 'bridge', origins: trusted, parentVerified: true };
  // A cross-origin parent the browser will not name. With nothing on the list
  // no parent can be trusted. With a list, the bridge only speaks to and
  // accepts messages from those origins, which the parent's own origin must match.
  if (cross.length > 0) return { kind: 'bridge', origins: trusted, parentVerified: false };
  return { kind: 'safe', reason: 'framed by a cross-origin page and no embedding origin is allowed' };
}

/** Read how `win` is framed. */
export function readFrameFacts(win: Window): FrameFacts {
  let framed: boolean;
  try {
    framed = win.top !== win;
  } catch {
    framed = true;
  }
  if (!framed) return { framed, ownOrigin: win.location.origin, ancestorOrigins: undefined, parentSameOrigin: false };
  const list = (win.location as Location & { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins;
  let parentSameOrigin = false;
  try {
    // Reading a cross-origin parent's location throws.
    parentSameOrigin = win.parent.location.origin === win.location.origin;
  } catch {
    parentSameOrigin = false;
  }
  return {
    framed,
    ownOrigin: win.location.origin,
    ancestorOrigins: list && list.length > 0 ? Array.from(list) : undefined,
    parentSameOrigin,
  };
}
