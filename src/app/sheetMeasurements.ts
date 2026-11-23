/**
 * sheetMeasurements.ts: the measurements and annotations a map sheet may draw,
 * read from the controllers with the panel's own figures and support grade.
 *
 * Only work on the analysed scan is offered, by the ownership rule every
 * scan-specific output shares (`measurementOwnership`): the layers its points
 * were picked on, else its recorded owner. The layer that was active while it
 * was drawn does not decide. A measurement across two scans, one naming a scan
 * that is closed or that two open layers claim, and unowned work while several
 * scans are open are left off.
 */
import type { Viewer } from '../render/Viewer';
import type { Annotation } from '../render/annotate/types';
import { annotationsOwnedByActive, ownershipOf, type OwnershipView } from './measurementOwnership';
import type { SheetMeasurement } from '../export/sheetKit/sheetMeasurement';

/** The annotations on the scan `view` describes, in panel order. */
export function sheetAnnotations(viewer: Viewer, view: OwnershipView): readonly Annotation[] {
  return annotationsOwnedByActive(viewer.annotate.getAnnotations(), view).own;
}

/** Kinds drawn as a closed ring. */
const RINGS = new Set(['area', 'volume', 'lasso']);

export function sheetMeasurements(viewer: Viewer, view: OwnershipView): SheetMeasurement[] {
  const byId = new Map(viewer.measure.getSummaries().map((s) => [s.id, s]));
  const out: SheetMeasurement[] = [];
  for (const m of viewer.measure.getMeasurements()) {
    if (ownershipOf(m, view).kind !== 'own') continue;
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
