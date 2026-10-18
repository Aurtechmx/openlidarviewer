/**
 * sessionUpAxisNote.ts — what a session restore says about up axes.
 *
 * A session records the active scan's format axis (`upAxis`) and, since the
 * per-layer frame rule, its resolved axis and basis (`upFrame`). Reopened, the
 * scan's frame is resolved again from its own CRS. When the two disagree (an
 * older file recorded a PLY under a CRS as Y-up, or the CRS changed since),
 * heights are read along the resolved axis, and stored profile charts and
 * volumes cut along the old one are re-cut or withheld; the toast says which.
 */

import type { LayerUpFrame } from '../geo/frame/layerUpFrame';
import type { SessionUpFrame } from '../io/session';

const BASIS_TEXT: Record<SessionUpFrame['basis'], string> = {
  specification: 'its format specification',
  crs: 'its coordinate system',
  detected: 'its point layout',
  explicit: 'the rule for its format with no coordinate system',
  unresolved: 'no resolved frame',
};

/** The sentence(s) appended to the restore toast, or '' when there is nothing to say. */
export function sessionUpAxisNote(input: {
  readonly recorded: SessionUpFrame | undefined;
  readonly formatAxis: 'y' | 'z';
  readonly live: LayerUpFrame | null;
  readonly recut: { readonly recut: number; readonly withheld: number };
}): string {
  const parts: string[] = [];
  const { live, recorded } = input;
  if (live?.ok) {
    const now = `${live.axis.toUpperCase()}-up (${BASIS_TEXT[live.basis]})`;
    if (recorded && (recorded.axis !== live.axis || recorded.basis !== live.basis)) {
      parts.push(`The session recorded the scan as ${recorded.axis.toUpperCase()}-up (${BASIS_TEXT[recorded.basis]}); heights are now read ${now}.`);
    } else if (!recorded && input.formatAxis !== live.axis) {
      parts.push(`The session recorded the scan's format axis, ${input.formatAxis.toUpperCase()}; heights are now read ${now}.`);
    }
  } else if (live && !live.ok) {
    parts.push(`The scan has no resolved up axis, so heights, grades, profiles and volumes are withheld: ${live.reason}`);
  }
  const { recut, withheld } = input.recut;
  if (recut > 0) parts.push(`${recut} profile or volume result${recut === 1 ? ' was' : 's were'} re-cut along the scan's resolved up axis.`);
  if (withheld > 0) parts.push(`${withheld} profile or volume result${withheld === 1 ? ' is' : 's are'} withheld: cut along another up axis and not re-cut here.`);
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Settle the cut axis of work a restore holds for a scan that is not open.
 * Held work is moved between frame records before it is placed, and its
 * stored profile heights and volume reference planes move with it, so the
 * axis they were cut along must be known. It is the measurement's own record;
 * else the session's recorded resolved frame when the work belongs to the scan
 * that frame describes. Otherwise it is not known (an older file records only
 * the format's axis, which is not evidence of the cut): the value is withheld
 * with the reason rather than moved along a guessed axis, and is re-cut along
 * the reopened layer's resolved frame when that layer opens.
 */
export function heldCutAxes<M extends {
  readonly kind: string;
  readonly owner?: { readonly layerId?: string };
  readonly pickLayers?: readonly string[];
  profileChart?: unknown;
  volume?: unknown;
  volumeResidentOnly?: boolean;
  derivedUpAxis?: 'y' | 'z';
  derivedWithheld?: string;
}>(measurements: readonly M[], recorded: SessionUpFrame | undefined, recordedLayerId: string | null): M[] {
  return measurements.map((m) => {
    if (m.derivedUpAxis || !(m.profileChart || m.volume)) return m;
    const layer = m.owner?.layerId ?? null;
    if (recorded && recorded.basis !== 'unresolved' && layer !== null && layer === recordedLayerId) {
      return { ...m, derivedUpAxis: recorded.axis };
    }
    const what = m.kind === 'profile' ? 'Profile chart' : 'Cut and fill';
    const next: M = {
      ...m,
      derivedWithheld: `${what} withheld: the session did not record the up axis it was cut along. It is re-cut along the layer's resolved up axis when the layer is open.`,
    };
    delete next.profileChart;
    delete next.volume;
    delete next.volumeResidentOnly;
    return next;
  });
}
