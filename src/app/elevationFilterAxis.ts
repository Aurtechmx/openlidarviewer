/**
 * elevationFilterAxis.ts — the elevation filter after a layer's up axis moves.
 *
 * The filter window is a range of heights in world/source units, and each
 * layer converts it along its own up axis. When a CRS assigned, replaced or
 * cleared moves a layer's resolved axis (a PLY becomes Z-up under a projected
 * CRS), points must never stay hidden or shown along the old axis:
 *
 * - the control is re-seeded with the scene's extent along the new axis; when
 *   that extent differs, the control resets and the window is cleared, and the
 *   user is told why (a range of northings is not a range of heights);
 * - a window that survives is re-applied, so every layer converts it along its
 *   new axis at once rather than on the next edit.
 */

/** The slice of the app the filter is re-expressed through. */
export interface ElevationFilterAxisDeps {
  /** The active window, or null when none is set. */
  active(): readonly [number, number] | null;
  /** The scene's elevation extent along the current up axis, or null. */
  extent(): { min: number; max: number } | null;
  /** Re-seed the filter control; a changed extent resets it and clears the window. */
  seedExtent(ext: { min: number; max: number } | null): void;
  /** Apply (or clear) the window in the renderer. */
  apply(range: readonly [number, number] | undefined): void;
  notify(message: string): void;
}

export const ELEVATION_FILTER_AXIS_CLEARED =
  "Elevation filter cleared: a layer's up axis changed with its coordinate system, so the height window set along the old axis no longer describes heights. Set the window again.";

/** Re-express the elevation filter after a layer's resolved up axis moved. */
export function reexpressElevationFilter(deps: ElevationFilterAxisDeps): void {
  const before = deps.active();
  deps.seedExtent(deps.extent());
  const after = deps.active();
  if (before && !after) {
    deps.notify(ELEVATION_FILTER_AXIS_CLEARED);
    return;
  }
  deps.apply(after ?? undefined);
}
