/**
 * sheetMeasurements.ts: the measurements a map sheet may draw, read from the
 * Measure controller with the panel's own figures and support grade.
 *
 * Only measurements on the analysed scan are offered: one that is unowned (a
 * scene of one scan leaves work unowned) or owned by that scan's stable layer
 * id. Work on another layer would land in the wrong place on this map.
 */
import type { Viewer } from '../render/Viewer';
import type { SheetMeasurement } from '../export/sheetKit/sheetMeasurement';

/** Kinds drawn as a closed ring. */
const RINGS = new Set(['area', 'volume', 'lasso']);

export function sheetMeasurements(viewer: Viewer, analysedStableId: string | null): SheetMeasurement[] {
  const byId = new Map(viewer.measure.getSummaries().map((s) => [s.id, s]));
  const out: SheetMeasurement[] = [];
  for (const m of viewer.measure.getMeasurements()) {
    const owner = m.owner?.layerId ?? null;
    if (owner != null && owner !== analysedStableId) continue;
    const s = byId.get(m.id);
    if (!s || m.points.length === 0) continue;
    const notes: string[] = [];
    if (s.volumeBaseLevel) notes.push(s.volumeBaseLevel);
    if (s.volumeResidentOnly) notes.push('Sampled from the streamed points loaded so far; may change as more load.');
    if (s.unitUnverified) notes.push('Unit unverified: the scan has no resolved linear unit.');
    out.push({
      name: s.name,
      kind: m.kind,
      value: s.value,
      grade: s.trust?.grade ?? null,
      support: s.trust?.caption ?? null,
      points: m.points.map((p) => [p[0], p[1], p[2]] as const),
      closed: RINGS.has(m.kind) && (m.kind !== 'area' || m.closed === true),
      notes,
    });
  }
  return out;
}
