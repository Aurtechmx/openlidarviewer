/**
 * ReportAnnotationSection.ts
 *
 * Builds the annotation row list the annotations section renders. Maps
 * the runtime `Annotation` shape (from `render/annotate/types`) into the
 * denormalised `ReportAnnotationRow` view the renderer consumes.
 *
 * Pure data — no DOM, no three.js. The runtime types are imported as
 * types only so this module stays tree-shakeable.
 */

import type { Annotation } from '../render/annotate/types';
import type { ReportAnnotationRow } from './types';

/**
 * Convert one runtime annotation to a report row.
 *
 * Position policy: prefer `worldPosition` (absolute survey coords) over
 * `localPosition` so analysts reading the report can correlate the annotation to
 * a survey coordinate. Falls back to `localPosition` when no world position
 * could be derived (an annotation with no owning cloud, or an older session).
 *
 * Honesty: the row records WHICH frame the coordinate is in (`frame`) and the
 * CRS label when known, so the renderer can label a render-local fallback as
 * such instead of presenting it as a surveyed location.
 */
function toRow(a: Annotation): ReportAnnotationRow {
  const world = a.worldPosition;
  const pos = world ?? a.localPosition;
  const row: ReportAnnotationRow = {
    title: a.title,
    type: a.type,
    note: a.note,
    position: { x: pos.x, y: pos.y, z: pos.z },
    frame: world ? 'world' : 'local',
    createdAt: a.createdAt,
  };
  if (world && a.crs) return { ...row, crs: a.crs };
  return row;
}

/**
 * Build the annotation row list. By default annotations are sorted by
 * `createdAt` ascending so the report reads as a chronological inspection
 * log; callers can pass `sortBy: 'type'` to group by note/info/warning/
 * issue instead (useful for QA reports that want all issues together).
 */
export function buildAnnotationRows(
  annotations: readonly Annotation[],
  options: { sortBy?: 'createdAt' | 'type' } = {},
): readonly ReportAnnotationRow[] {
  const rows = annotations.map(toRow);
  if (options.sortBy === 'type') {
    // Stable ordering within each type — issue first, then warning,
    // then info, then note. Matches the live annotation panel's
    // QA-prioritised order.
    const typeRank: Record<string, number> = { issue: 0, warning: 1, info: 2, note: 3 };
    rows.sort((a, b) => {
      const ra = typeRank[a.type] ?? 9;
      const rb = typeRank[b.type] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.createdAt - b.createdAt;
    });
  } else {
    rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  return rows;
}
