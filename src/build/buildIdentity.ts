/**
 * buildIdentity.ts — the single build-time identity of this bundle.
 *
 * Before this module the app knew only its marketing version string
 * (`__APP_VERSION__`, from package.json). That answers "which release" but not
 * "which build" — and two builds of the same release (a clean tag vs a dirty
 * working tree, yesterday vs today, the readable GitHub build vs the live
 * deployment) are materially different artifacts. Provenance that records only
 * the version cannot tell them apart.
 *
 * This is the one identity, resolved once at build time (see
 * `resolveBuildIdentity` in vite.config.ts) and frozen into the bundle as the
 * `__BUILD_IDENTITY__` global. Every surface that needs to say which build
 * produced an output — the console banner, the debug overlay, and (the reason
 * this matters) export provenance — reads it from HERE, so they can never drift.
 *
 * Honesty contract: when git is unavailable at build time (e.g. a source
 * tarball with no `.git`), `commit` is the literal `'unknown'` and `dirty` is
 * `false` — we never fabricate a hash. `builtAt` honours `SOURCE_DATE_EPOCH` so
 * a reproducible build can pin it.
 *
 * Pure data + pure string helpers: no DOM, no three.js, no I/O.
 */

/** The immutable identity of one build of the app. */
export interface BuildIdentity {
  /** Release version from package.json, e.g. `"0.5.7"`. */
  readonly version: string;
  /** Short git commit the build was cut from, or the literal `"unknown"`. */
  readonly commit: string;
  /** True when the working tree had uncommitted changes at build time. */
  readonly dirty: boolean;
  /** ISO 8601 build timestamp (honours `SOURCE_DATE_EPOCH`). */
  readonly builtAt: string;
  /** Node version the build ran under, e.g. `"v22.22.3"`. */
  readonly node: string;
  /** Build channel: `"live"` (deployment), `"plain"` (GitHub build), `"dev"`. */
  readonly channel: string;
}

/** The identity of THIS build, stamped by Vite's `define`. */
export const BUILD_IDENTITY: BuildIdentity = __BUILD_IDENTITY__;

/** True when the commit is a real resolved hash (not the `'unknown'` fallback). */
function hasCommit(id: BuildIdentity): boolean {
  return id.commit.length > 0 && id.commit !== 'unknown';
}

/**
 * Compact human label: `"0.5.7 (a1b2c3d)"`, with `+dirty` appended when the
 * working tree was dirty. Falls back to `"0.5.7 (dirty)"` when the commit is
 * unknown but the tree was dirty, and to plain `"0.5.7"` when neither is known.
 */
export function buildIdentityLabel(id: BuildIdentity = BUILD_IDENTITY): string {
  if (hasCommit(id)) return `${id.version} (${id.commit}${id.dirty ? '+dirty' : ''})`;
  if (id.dirty) return `${id.version} (dirty)`;
  return id.version;
}

/**
 * One-line provenance: `"0.5.7 (a1b2c3d) · live · built 2026-07-08T18:22:00Z"`.
 * Used verbatim in export provenance so a downstream reader sees exactly which
 * build produced the artifact.
 */
export function buildIdentityProvenance(id: BuildIdentity = BUILD_IDENTITY): string {
  return `${buildIdentityLabel(id)} · ${id.channel} · built ${id.builtAt}`;
}
