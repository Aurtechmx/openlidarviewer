/**
 * classScope.ts
 *
 * Describes how far a class filter narrows the view, for provenance
 * stamping on exports and snapshots. A view is either "full" (every
 * class present in the cloud is shown) or a "subset" (only some of the
 * present classes are visible). The subset carries the visible class
 * codes plus the total number of present classes, so a stamp can read
 * "ground · 1 of 3 classes".
 *
 * The intersection is deliberate: a class can be toggled visible in the
 * UI yet be absent from this particular cloud, and such codes must not
 * leak into the scope. Only codes that are both visible AND present
 * count.
 *
 * Pure data — no DOM, no three.js, no I/O.
 */

/** Maps a class code to its display name. */
export type ClassNameFn = (code: number) => string;

/**
 * Either the unfiltered view, or a subset limited to `codes` out of
 * `totalPresent` classes found in the cloud.
 */
export type ClassScope =
  | { kind: 'full' }
  | { kind: 'subset'; codes: number[]; totalPresent: number };

/** The unfiltered scope — every present class is shown. */
export function fullScope(): ClassScope {
  return { kind: 'full' };
}

/**
 * Derives a scope from the currently visible codes and the codes
 * actually present in the cloud. If every present code is visible the
 * result is `full`; otherwise it is a `subset` of the visible∩present
 * codes (ascending) with `totalPresent` = number of present codes.
 */
export function scopeFrom(
  visibleCodes: number[],
  presentCodes: number[],
  _nameOf: ClassNameFn,
): ClassScope {
  const visibleSet = new Set(visibleCodes);
  const present = [...presentCodes].sort((a, b) => a - b);
  const shown = present.filter((code) => visibleSet.has(code));
  if (shown.length === present.length) {
    return { kind: 'full' };
  }
  return { kind: 'subset', codes: shown, totalPresent: present.length };
}

/**
 * Renders a scope as a provenance string: `''` for a full view, or
 * `"<names joined by ' + '> · <k> of <m> classes"` for a subset, where
 * k is the number of shown codes and m is the total present.
 */
export function scopeStamp(scope: ClassScope, nameOf: ClassNameFn): string {
  if (scope.kind === 'full') return '';
  const names = scope.codes.map(nameOf).join(' + ');
  return `${names} · ${scope.codes.length} of ${scope.totalPresent} classes`;
}
