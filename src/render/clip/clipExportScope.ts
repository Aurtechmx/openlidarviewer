/**
 * clipExportScope.ts: the one step that decides which points of a source cloud an
 * export writes.
 *
 * Every point writer goes through {@link prepareExportScope}: the conversion
 * export in the Export panel and the quick-format buttons beside it. An active
 * clip box keeps the points inside (or outside) it, tested in the project
 * frame the viewer draws the box in, so a placed layer is offset into that
 * frame first. The result carries the scope line the file and the status
 * state, so a clipped file is never mistaken for the whole scan.
 *
 * Pure: no DOM, no viewer. The caller captures the clip and the offset when
 * the user presses Export and passes them in.
 */

import type { PointCloud } from '../../model/PointCloud';
import type { ClipBox } from './clipBox';
import { clipCloud } from './clipCloud';
import { clipScopeText } from './clipScope';

type Vec3 = readonly [number, number, number];

/**
 * The offset that places `cloud` in the project frame. The layer's offset is
 * stated against the displayed cloud's source origin; a full-resolution
 * re-decode may carry a different one, and the difference is folded in.
 */
export function clipFrameOffset(
  offset: Vec3 | null,
  displayOrigin: Vec3 | null,
  cloud: PointCloud,
): Vec3 | null {
  const o = cloud.sourceOrigin;
  const d = displayOrigin ?? o;
  const t = offset ?? [0, 0, 0];
  const out: [number, number, number] = [t[0] + o[0] - d[0], t[1] + o[1] - d[1], t[2] + o[2] - d[2]];
  return out.every((v) => v === 0) ? null : out;
}

/** The clip and placement an export was asked for, captured at the click. */
export interface ExportScopeRequest {
  /** The active clip box, or null for none. A disabled clip keeps everything. */
  readonly clip: ClipBox | null;
  /** The layer's source-local to project-frame offset, or null for none. */
  readonly clipOffset: Vec3 | null;
  /** The source origin of the cloud the offset was stated against (the displayed cloud). */
  readonly displayOrigin: Vec3 | null;
}

/** The points an export writes and how they relate to their source. */
export interface ExportScope {
  /** The cloud to write: the source itself, or the subset the clip keeps. */
  readonly cloud: PointCloud;
  /** "Clipped: k of n points", or null when the whole source is written. */
  readonly scopeNote: string | null;
}

/** The points of `source` the captured request keeps, with the line that discloses a clip. */
export function prepareExportScope(source: PointCloud, req: ExportScopeRequest): ExportScope {
  const clip = req.clip;
  const cloud = clip?.enabled ? clipCloud(source, clip, clipFrameOffset(req.clipOffset, req.displayOrigin, source)) : source;
  return {
    cloud,
    scopeNote: cloud === source ? null : clipScopeText({ kept: cloud.pointCount, total: source.pointCount }),
  };
}
