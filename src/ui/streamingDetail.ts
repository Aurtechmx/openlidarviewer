/**
 * streamingDetail.ts — the Inspector's Detail readout for a STREAMING source.
 *
 * A static cloud is held whole, so `Inspector.setDetail(shown, total)` states a
 * subsample against the file it came from and the two numbers answer one
 * question. A streaming source is different: the viewer holds a bounded, camera
 * driven subset of an octree it never downloads in full, and THREE quantities
 * are in play at once.
 *
 *   SOURCE TOTAL   what the source document declares it contains. Fixed for the
 *                  session, and for some 3D Tiles tilesets simply absent — the
 *                  hierarchy names content URIs, not point totals.
 *   RESIDENT SET   what is uploaded and drawable right now. Moves every tick as
 *                  the scheduler admits and evicts nodes.
 *   VIEW READINESS whether the nodes THIS camera asked for have arrived. Comes
 *                  from the scheduler's wanted set (`refinementReadiness.ts`)
 *                  and is not a function of either count above: a 5 % resident
 *                  source can carry a fully settled view, because the wanted
 *                  set is what the current camera needs, not the whole file.
 *
 * Collapsing the first two is what this module exists to prevent. The streaming
 * opens used to call `setDetail(sourcePointCount, sourcePointCount)`, so an
 * 89.6 M point COPC read "89.6M / 89.6M points" at 100 % from the first frame,
 * over a scene holding a few million points. {@link StreamingDetail} keeps them
 * as separate named fields so no call site can transpose them, and carries the
 * declaration state as its own flag so an absent total is a value rather than
 * a zero.
 *
 * The vocabulary is deliberate. "Resident", "Source" and "Current residency"
 * describe a viewer that holds part of a source ON PURPOSE. "Downloaded",
 * "loaded" or a completion percentage would describe a viewer that is expected
 * to hold all of it and has not finished, which is not what an out-of-core
 * renderer is doing.
 *
 * Pure except for {@link renderStreamingDetail}, which is the one DOM writer,
 * so the wording and the arithmetic can be pinned without an Inspector.
 */

import { el, formatCount } from './dom';

/**
 * The counts one Detail readout is built from.
 *
 * A typed object rather than positional arguments: `residentPointCount` and
 * `sourcePointCount` are both point counts of the same magnitude, so a
 * positional seam accepts them in either order and compiles.
 */
export interface StreamingDetail {
  /** Points uploaded and drawable right now. Always known. */
  readonly residentPointCount: number;
  /** The total the source declares, or `null` when it declares none. */
  readonly sourcePointCount: number | null;
  /**
   * Whether the source declares an authoritative total.
   *
   * Stated separately from `sourcePointCount` being non-null so a caller has to
   * decide rather than let a number's presence stand in for its authority. The
   * two disagreeing is read as UNDECLARED either way: a figure the caller did
   * not vouch for is not a total, and a flag over a null total states nothing.
   */
  readonly sourcePointCountKnown: boolean;
}

/** The statements the readout puts on screen. */
export interface StreamingDetailReadout {
  /** "Resident 3.0M points". */
  readonly resident: string;
  /** "Source 90.0M points", or the undeclared-total statement. */
  readonly source: string;
  /** "Current residency 3.33%", or `null` when there is no denominator. */
  readonly residency: string | null;
  /** The statements in render order — `residency` omitted when absent. */
  readonly lines: readonly string[];
}

/** What the readout says when the source declares no total of its own. */
export const UNDECLARED_SOURCE_TOTAL = 'Source total not declared by the source';

/**
 * The declared total, or `null`. Both halves of the pair have to agree: a count
 * arriving with `sourcePointCountKnown: false` is one the caller has not
 * established, and a `true` flag over a null count establishes nothing.
 */
function declaredTotal(detail: StreamingDetail): number | null {
  const { sourcePointCount, sourcePointCountKnown } = detail;
  if (!sourcePointCountKnown || sourcePointCount === null) return null;
  return Number.isFinite(sourcePointCount) && sourcePointCount >= 0 ? sourcePointCount : null;
}

/**
 * Resident over source as a percentage string.
 *
 * Two decimals at most, trailing zeros dropped, so a whole 100 % reads "100%"
 * and a small fraction keeps its precision ("3.33%"). A non-zero residency that
 * would round to nothing reads "<0.01%" rather than "0%", because "0%" over a
 * scene with points on screen is the same lie in the other direction. Clamped
 * at 100 for display safety; a resident count above the declared total means a
 * source whose header under-states it, not a scene holding more than exists.
 */
function residencyPercent(resident: number, source: number): string {
  const pct = Math.min(100, (Math.max(0, resident) / source) * 100);
  const rounded = Math.round(pct * 100) / 100;
  if (rounded === 0 && resident > 0) return '<0.01%';
  return `${rounded}%`;
}

/**
 * Build the three statements from one set of counts. Pure.
 *
 * A source with no declared total gets no percentage: there is no denominator,
 * and estimating one (known nodes × average points per node, say) would publish
 * a residency against a figure nothing measured.
 */
export function streamingDetailReadout(detail: StreamingDetail): StreamingDetailReadout {
  const total = declaredTotal(detail);
  const resident = `Resident ${formatCount(Math.max(0, detail.residentPointCount))} points`;
  const source = total === null ? UNDECLARED_SOURCE_TOTAL : `Source ${formatCount(total)} points`;
  // An empty declared source has a real total and no residency to state: 0 / 0
  // is undefined, and reporting either 0 % or 100 % would invent an answer.
  const residency =
    total !== null && total > 0
      ? `Current residency ${residencyPercent(detail.residentPointCount, total)}`
      : null;
  return {
    resident,
    source,
    residency,
    lines: residency === null ? [resident, source] : [resident, source, residency],
  };
}

/**
 * Write the readout into `host`, replacing whatever was there.
 *
 * `replaceChildren` is what makes a scan replacement safe: an open whose source
 * declares no total publishes the undeclared statement and the previous scan's
 * figures go with the nodes they were written into, rather than staying on
 * screen attributed to the scan that replaced it.
 *
 * No progress bar. The static readout draws one because "shown of total" is a
 * subsample of a cloud the viewer holds; a bar at 3 % here would read as a
 * download that has not finished, which is the reading this module exists to
 * remove. Node-level progress stays on the streaming panel, where it is about
 * the scheduler rather than the source.
 */
export function renderStreamingDetail(host: HTMLElement, detail: StreamingDetail): void {
  const readout = streamingDetailReadout(detail);
  host.replaceChildren(
    el(
      'div',
      { className: 'olv-detail-text' },
      readout.lines.map((text) => el('div', { text })),
    ),
  );
}

/**
 * Empty the readout.
 *
 * Called when the Inspector leaves streaming layout: a resident/source figure
 * belongs to the scan it was measured from, and a closed scan's figure standing
 * over whatever is shown next is the same misattribution a source that declares
 * no total would make by staying silent.
 */
export function clearStreamingDetail(host: HTMLElement): void {
  host.replaceChildren();
}
