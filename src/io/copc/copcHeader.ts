/**
 * copcHeader.ts
 *
 * Parses the LAS 1.4 public header and the COPC `info` VLR from a file's head
 * slice — the cheap preflight that produces {@link CopcMetadata} before any
 * hierarchy page or point chunk is read.
 *
 * Malformed input (a non-COPC point format, an impossible octree, a bad root
 * hierarchy size) is rejected with a typed `LoadError('malformed-file', …)` so
 * the load surfaces a clear message rather than failing deep in the pipeline.
 *
 * Pure — no DOM, no three.js, no I/O.
 */

import { LoadError } from '../loadErrors';
import { parseCrsFromVlrs } from '../crs';
import type { CopcMetadata, CopcHeaderInfo, CopcInfo } from './copcTypes';

/** Offset of the COPC `info` VLR payload: 375 header + 54 VLR header. */
const INFO_VLR_PAYLOAD_OFFSET = 429;

/** The minimum head-slice length: header + info VLR header + info payload. */
const MIN_HEAD_BYTES = INFO_VLR_PAYLOAD_OFFSET + 160;

/**
 * Parse the LAS 1.4 header and COPC `info` VLR from `headSlice` (at least the
 * first 589 bytes of the file). Throws `LoadError('malformed-file')` on
 * structurally invalid input.
 */
export function parseCopcMetadata(headSlice: ArrayBuffer): CopcMetadata {
  if (headSlice.byteLength < MIN_HEAD_BYTES) {
    throw new LoadError('malformed-file', 'COPC header slice is too short to parse.');
  }
  const view = new DataView(headSlice);

  // --- LAS 1.4 public header -------------------------------------------------
  const headerSize = view.getUint16(94, true);
  if (headerSize < 375) {
    throw new LoadError('malformed-file', 'LAS header size is invalid for a COPC file.');
  }

  // PDRF: low six bits; the two high bits are the LAZ compression flag.
  const pdrf = view.getUint8(104) & 0x3f;
  if (pdrf !== 6 && pdrf !== 7 && pdrf !== 8) {
    throw new LoadError(
      'malformed-file',
      `COPC requires point data record format 6, 7, or 8 — this file is ${pdrf}.`,
    );
  }

  const pointRecordLength = view.getUint16(105, true);
  if (pointRecordLength <= 0) {
    throw new LoadError('malformed-file', 'LAS point record length is invalid.');
  }

  const scale: [number, number, number] = [
    view.getFloat64(131, true),
    view.getFloat64(139, true),
    view.getFloat64(147, true),
  ];
  const offset: [number, number, number] = [
    view.getFloat64(155, true),
    view.getFloat64(163, true),
    view.getFloat64(171, true),
  ];
  // Bounds are stored max-then-min per axis.
  const max: [number, number, number] = [
    view.getFloat64(179, true),
    view.getFloat64(195, true),
    view.getFloat64(211, true),
  ];
  const min: [number, number, number] = [
    view.getFloat64(187, true),
    view.getFloat64(203, true),
    view.getFloat64(219, true),
  ];
  // Scale, offset and bounds seed every coordinate conversion downstream —
  // the render origin, node bounds, camera framing. A non-finite value (or a
  // non-positive scale) from a corrupt header would propagate NaN through all
  // of them, so reject the file up front.
  if (scale.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new LoadError('malformed-file', 'LAS header scale factor is invalid.');
  }
  if (offset.some((v) => !Number.isFinite(v))) {
    throw new LoadError('malformed-file', 'LAS header offset is invalid.');
  }
  if (min.some((v) => !Number.isFinite(v)) || max.some((v) => !Number.isFinite(v))) {
    throw new LoadError('malformed-file', 'LAS header bounds are invalid.');
  }
  const pointCount = Number(view.getBigUint64(247, true));
  if (!Number.isFinite(pointCount) || pointCount < 0) {
    throw new LoadError('malformed-file', 'LAS point count is invalid.');
  }

  // walk the LAS VLR list for a LASF_Projection CRS VLR.
  // COPC files always start with the COPC info VLR at offset 375; any
  // LASF_Projection VLRs follow it. The head-slice the preflight reads is
  // typically large enough to include them; `parseCrsFromVlrs` handles a
  // truncated slice by returning `null` so we can proceed without CRS.
  const numVlr = view.getUint32(100, true);
  const crs = (numVlr > 0)
    ? parseCrsFromVlrs(headSlice, headerSize, numVlr)
    : null;

  const header: CopcHeaderInfo = {
    pointDataRecordFormat: pdrf,
    pointRecordLength,
    pointCount,
    scale,
    offset,
    min,
    max,
    hasRgb: pdrf === 7 || pdrf === 8,
    hasGpsTime: true,
    crs,
  };

  // --- COPC info VLR payload -------------------------------------------------
  const ip = INFO_VLR_PAYLOAD_OFFSET;
  const info: CopcInfo = {
    center: [
      view.getFloat64(ip, true),
      view.getFloat64(ip + 8, true),
      view.getFloat64(ip + 16, true),
    ],
    halfsize: view.getFloat64(ip + 24, true),
    spacing: view.getFloat64(ip + 32, true),
    rootHierOffset: Number(view.getBigUint64(ip + 40, true)),
    rootHierSize: Number(view.getBigUint64(ip + 48, true)),
    gpsTimeRange: [
      view.getFloat64(ip + 56, true),
      view.getFloat64(ip + 64, true),
    ],
  };

  // The octree center becomes the render origin (floored); a NaN here would
  // survive into bounds and camera framing for the whole session.
  if (info.center.some((v) => !Number.isFinite(v))) {
    throw new LoadError('malformed-file', 'COPC octree center is invalid.');
  }
  if (!Number.isFinite(info.halfsize) || info.halfsize <= 0) {
    throw new LoadError('malformed-file', 'COPC octree half-size is invalid.');
  }
  if (!Number.isFinite(info.spacing) || info.spacing <= 0) {
    throw new LoadError('malformed-file', 'COPC point spacing is invalid.');
  }
  if (
    !Number.isFinite(info.rootHierOffset) ||
    info.rootHierOffset <= 0 ||
    !Number.isFinite(info.rootHierSize) ||
    info.rootHierSize <= 0 ||
    info.rootHierSize % 32 !== 0
  ) {
    throw new LoadError('malformed-file', 'COPC root hierarchy location is invalid.');
  }

  return { header, info };
}
