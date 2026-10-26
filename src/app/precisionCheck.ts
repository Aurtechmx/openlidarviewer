/**
 * precisionCheck.ts: the Performance panel's precision check and certificate.
 *
 * Both read the per-draw precision bound (`science/drawPrecision.ts`, the
 * vendored checker from "Per-Draw Precision Bounds for Large-Coordinate
 * Rendering in WebGL2 and WebGPU") for the active loaded scan at the current
 * camera, against a tolerance the reader picks. The check states the result in
 * one line; the certificate records it with everything it depends on, so a
 * reader can attach it to a deliverable and anyone can tell which data, view,
 * shader and contract it covers.
 *
 * What it covers is the scan report row's scope: the eye-space position of each
 * point centre as the GPU computes it, before projection, under round-to-nearest
 * binary32 arithmetic. It is not survey accuracy and not a screen-space error.
 * A streamed scan is not evaluated (its draw path is not the verified one).
 *
 * Pure apart from the getters it is handed: no DOM.
 */

import type { PointCloud } from '../model/PointCloud';
import { sourcePositions } from '../model/pointFrames';
import { groundMetresPermitted, type SpatialContext } from '../geo/SpatialContext';
import { layerUpFrameFromContext } from '../geo/frame/layerUpFrame';
import { formatPrecisionMetres } from '../geo/inMemoryPrecision';
import {
  DRAW_PRECISION_CONTRACT,
  DRAW_PRECISION_METHOD_ID,
  drawPrecisionUnitOf,
  evaluateDrawPrecision,
  tileFromLocalFloat32,
  type DrawPrecisionDiagnostic,
  type DrawPrecisionUnit,
} from '../science/drawPrecision';
import { drawPrecisionViewFor, type DrawPrecisionViewer } from './drawPrecisionView';
import { DRAW_PRECISION_LOD_METHOD_ID, selectCertifiedLevel, type LodSelection } from '../science/drawPrecisionLod';
import { method, methodRef, methodTag } from '../science/methodRegistry';
import { sha256Hex } from '../terrain/export/sha256';
import { buildIdentityLabel } from '../build/buildIdentity';
import { sourceDigestReady } from '../io/sourceFiles';
import { loadExportDigests } from '../lazyChunks';

/** The tolerances the panel offers, in metres. */
export const PRECISION_TOLERANCES: readonly { readonly label: string; readonly metres: number }[] = Object.freeze([
  { label: '1 mm', metres: 0.001 },
  { label: '1 cm', metres: 0.01 },
  { label: '10 cm', metres: 0.1 },
]);

/** What the check covers, stated once for the panel and the certificate. */
export const PRECISION_SCOPE =
  'Rendering error against the stored coordinates, before projection. Not survey accuracy.';

/** The method, named where the check is offered. */
export const PRECISION_METHOD_NOTE = 'Method: per-draw precision bound (A. Urias).';

/** What every bound is measured against. */
const PRECISION_REFERENCE =
  'each point as computed in binary64 from the stored coordinates and the same model-view, before projection';

/** What the panel hands the check: getters, so the panel holds no scene state. */
export interface PrecisionDeps {
  viewer(): DrawPrecisionViewer | null;
  activeId(): string | null;
  activeCloud(): PointCloud | null | undefined;
  context(): SpatialContext;
}

export type PrecisionState = DrawPrecisionDiagnostic['state'] | 'NO_SCAN';

export interface PrecisionReading {
  readonly state: PrecisionState;
  /** One plain sentence for the panel. */
  readonly line: string;
  readonly diagnostic: DrawPrecisionDiagnostic | null;
  /** The points the bound covers: those drawn for the open scan. */
  readonly pointsDrawn: number;
  /** The coarsest certified level at this view, when asked for. */
  readonly lod: LodSelection | null;
}

/**
 * One check, captured whole and at once: the scan, every fact the result was
 * evaluated from, and the result. A certificate is built from this and nothing
 * else, so a scan, camera or unit that changes while the source file is being
 * hashed cannot reach a certificate taken before it changed.
 */
export interface PrecisionRequest {
  /** The scan the check read; its source file is the one hashed. */
  readonly cloud: PointCloud;
  readonly capturedAt: Date;
  readonly tauMetres: number;
  readonly dataset: {
    readonly name: string;
    readonly sourceFingerprint: string | null;
    readonly pointsDrawn: number;
    readonly declaredPoints: number;
  };
  readonly frame: {
    readonly crs: number | null;
    readonly origin: readonly number[];
    readonly localExtent: readonly number[];
    readonly storageErrorBound: readonly number[];
    readonly storageBasis: string;
    /** Which storage axis is vertical, as the unit was built for it. */
    readonly verticalAxis: 'z' | 'not-z';
    readonly verticalScale: SpatialContext['verticalScaleState'];
    /** The unit the bound was graded under: every factor and gate it read. */
    readonly gradedUnder: DrawPrecisionUnit;
  };
  readonly modelView64: readonly number[];
  /** Round to nearest: the contract the limit is checked under. */
  readonly diagnostic: DrawPrecisionDiagnostic;
  /** The faithful rounding the WGSL and GLSL ES specs guarantee: the worst case. */
  readonly faithful: DrawPrecisionDiagnostic;
  /** The coarsest level that fits the limit under faithful rounding, when asked for. */
  readonly lod: LodSelection | null;
}

/**
 * Evaluate the active scan at the current view and capture the request, or say
 * why not. `lod` also selects the coarsest certified level: `'count'` counts
 * its points (a press of Check, a certificate), `'live'` reuses a count already
 * made, so the refresh that follows the camera stays cheap.
 */
export function capturePrecisionRequest(
  deps: PrecisionDeps,
  tauMetres: number,
  now: Date = new Date(),
  options: { readonly lod?: 'count' | 'live' } = {},
): PrecisionRequest | string {
  const viewer = deps.viewer();
  const cloud = deps.activeCloud();
  if (!viewer || !cloud) return 'Open a scan to check its precision.';
  const view = drawPrecisionViewFor(viewer, deps.activeId(), cloud);
  if (!view) return 'The check covers a loaded scan; a streamed scan is not checked.';
  const context = deps.context();
  const upFrame = layerUpFrameFromContext(cloud.sourceFormat, context);
  const zUp = upFrame.ok && upFrame.axis === 'z';
  const positions = sourcePositions(cloud);
  const tile = tileFromLocalFloat32(positions);
  const unit = drawPrecisionUnitOf(context, { horizontalKnown: groundMetresPermitted(context), zUp });
  return {
    cloud,
    capturedAt: now,
    tauMetres,
    dataset: {
      name: cloud.name,
      sourceFingerprint: cloud.sourceDigest ?? null,
      pointsDrawn: cloud.pointCount,
      declaredPoints: cloud.declaredPointCount ?? cloud.pointCount,
    },
    frame: {
      crs: context.epsg ?? null,
      origin: [...cloud.sourceOrigin],
      localExtent: [...tile.r],
      storageErrorBound: [...tile.rho],
      storageBasis: tile.basis,
      verticalAxis: zUp ? 'z' : 'not-z',
      verticalScale: context.verticalScaleState,
      gradedUnder: { ...unit },
    },
    modelView64: Array.from(view.modelView64),
    diagnostic: evaluateDrawPrecision(tile, view, unit, tauMetres, 'rn'),
    faithful: evaluateDrawPrecision(tile, view, unit, tauMetres, 'faithful'),
    lod: options.lod
      ? selectCertifiedLevel(positions, tile, view, unit, tauMetres, { count: options.lod === 'count' ? true : 'cached' })
      : null,
  };
}

/** A limit as the panel offers it ("1 cm"), or in millimetres when it is not one of those. */
function limitLabel(tauMetres: number): string {
  return PRECISION_TOLERANCES.find((t) => t.metres === tauMetres)?.label ?? formatPrecisionMetres(tauMetres);
}

/** The contract named after a bound: round to nearest, and the spec's worst case when known. */
function contractNote(faithful: DrawPrecisionDiagnostic | null): string {
  const worst = faithful?.boundMetres;
  return worst != null && Number.isFinite(worst)
    ? ` (round-to-nearest; ${formatPrecisionMetres(worst)} worst case under the spec)`
    : ' (round-to-nearest)';
}

/** The panel's sentence for a diagnostic, naming the contract it holds under. */
export function precisionLine(d: DrawPrecisionDiagnostic, tauMetres: number, faithful: DrawPrecisionDiagnostic | null = null): string {
  const limit = limitLabel(tauMetres);
  const contract = contractNote(faithful);
  switch (d.state) {
    case 'PASS':
      return `Rendering error at most ${formatPrecisionMetres(d.boundMetres ?? Number.NaN)} at this view${contract}, inside the ${limit} limit.`;
    case 'NOT_CERTIFIED':
      return `Rendering error bound ${formatPrecisionMetres(d.boundMetres ?? Number.NaN)} at this view${contract}: not certified for the ${limit} limit.`;
    case 'UNGRADED':
      return `Rendering error bound ${(d.boundSourceUnits ?? Number.NaN).toPrecision(3)} source units at this view (round-to-nearest); ${d.reason ?? 'no unit'}, so no limit is checked.`;
    case 'NOT_TESTED':
      return `Not checked: ${d.reason ?? 'the draw is outside the checker domain'}.`;
  }
}

/** A cell size as read: millimetres below a metre, metres above. */
function cellLabel(metres: number): string {
  return metres < 1 ? `${Number((metres * 1000).toPrecision(4))} mm cells` : `${Number(metres.toPrecision(4))} m cells`;
}

/** The panel's sentence for a level selection, or null when no limit was checked. */
export function lodLine(s: LodSelection | null): string | null {
  if (!s || s.state === 'UNGRADED' || s.state === 'NOT_TESTED') return null;
  const limit = limitLabel(s.tauMetres);
  if (s.state === 'NONE') {
    return `No level of detail is within the ${limit} limit under faithful rounding (bound ${formatPrecisionMetres(s.bMetres ?? Number.NaN)}).`;
  }
  const sum = `${formatPrecisionMetres(s.hMetres ?? 0)} + ${formatPrecisionMetres(s.bMetres ?? Number.NaN)} ≤ ${limit}`;
  if (s.level === 0) {
    return `Coarsest level within the limit: full resolution (bound ${formatPrecisionMetres(s.bMetres ?? Number.NaN)} ≤ ${limit}, faithful rounding). No coarser level fits.`;
  }
  const share = s.pointsKept !== null && s.pointsFull > 0 ? `, ${((s.pointsKept / s.pointsFull) * 100).toFixed(1)}% of points` : '';
  return `Coarsest level within the limit: ${cellLabel(s.cellSizeMetres ?? Number.NaN)}${share} (${sum}, faithful rounding). Not drawn in this version.`;
}

/** Check the active scan at the current view against `tauMetres`; `lod` also selects its certified level. */
export function readPrecision(deps: PrecisionDeps, tauMetres: number, options: { readonly lod?: 'count' | 'live' } = {}): PrecisionReading {
  const e = capturePrecisionRequest(deps, tauMetres, new Date(), options);
  if (typeof e === 'string') return { state: 'NO_SCAN', line: e, diagnostic: null, pointsDrawn: 0, lod: null };
  return {
    state: e.diagnostic.state,
    line: precisionLine(e.diagnostic, tauMetres, e.faithful),
    diagnostic: e.diagnostic,
    pointsDrawn: e.dataset.pointsDrawn,
    lod: e.lod,
  };
}

/** The evidence state as the paper's Table 3 names it. */
function boundState(d: DrawPrecisionDiagnostic): string {
  switch (d.state) {
    case 'PASS': return 'PASS_BOUND';
    case 'NOT_CERTIFIED': return 'NOT_CERTIFIED_BOUND';
    case 'UNGRADED': return 'NOT_APPLICABLE';
    case 'NOT_TESTED': return 'NOT_TESTED';
  }
}

/** One contract's bound and the checker's evidence for it. */
function boundRecord(d: DrawPrecisionDiagnostic): object {
  return {
    contract: d.contract,
    boundState: boundState(d),
    boundMetres: d.boundMetres,
    boundSourceUnits: d.boundSourceUnits,
    evidence: d.evidence,
    reason: d.reason,
  };
}

/**
 * The camera position in the scan's coordinates (source units), from the
 * binary64 model-view: the point it maps to the eye-space origin. Null when the
 * linear part cannot be inverted.
 */
export function cameraPositionOf(modelView64: readonly number[], origin: readonly number[]): [number, number, number] | null {
  const m = modelView64;
  // Column-major: A[r][c] = m[c * 4 + r]; solve A x = -t for the local eye position.
  const a = [m[0], m[4], m[8]], b = [m[1], m[5], m[9]], c = [m[2], m[6], m[10]];
  const t = [-m[12], -m[13], -m[14]];
  const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const solve = (col: 0 | 1 | 2): number => {
    const M = [[...a], [...b], [...c]];
    for (let r = 0; r < 3; r++) M[r][col] = t[r];
    const d = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
    return d / det;
  };
  return [solve(0) + origin[0], solve(1) + origin[1], solve(2) + origin[2]];
}

/** JSON with keys in the order given, so the same scope always hashes the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/** The scan's whole-file SHA-256 and why it is missing when it is. */
export interface SourceHash {
  readonly sha256: string | null;
  readonly note: string | null;
}

/** What the bound holds for: the envelope it was taken over, not a named set of points. */
const HOLDS_FOR =
  'Every point stored within the stated local extent and storage error bound, drawn with this model-view '
  + 'under the stated contract and shader expression. The bound depends on that envelope, not on which points '
  + 'fill it; the source hash and point counts say which data it was taken from. Any other draw needs its own check.';

/**
 * The certificate for a captured request, as JSON. It records both contracts'
 * bounds with the checker's evidence, the frame and unit they were graded
 * under, the camera and the scan's hash. `scopeDigest` is the SHA-256 of that
 * scope, which holds every input that can change the result: a certificate is
 * void once any of it changes, and two certificates with the same digest cover
 * the same draw. The time it was taken is not part of the scope.
 */
export function certificateOf(request: PrecisionRequest, sourceHash: SourceHash | null = null): string {
  const { diagnostic: d, faithful, tauMetres } = request;
  const scope = {
    method: methodTag(methodRef(DRAW_PRECISION_METHOD_ID)),
    dataset: { ...request.dataset, sourceSha256: sourceHash?.sha256 ?? null },
    frame: request.frame,
    camera: {
      positionInScanCoordinates: cameraPositionOf(request.modelView64, request.frame.origin),
      modelView64: request.modelView64,
    },
    draw: {
      strategy: 'model-view composed in binary64 on the CPU, narrowed to binary32 once',
      expression: d.expression,
      backend: d.backend,
    },
    requirement: { toleranceMetres: tauMetres, checkedUnder: DRAW_PRECISION_CONTRACT },
  };
  const certificate = {
    kind: 'olv.draw-precision-certificate',
    version: 3,
    citation: method(DRAW_PRECISION_METHOD_ID)?.citation ?? null,
    generatedAt: request.capturedAt.toISOString(),
    build: buildIdentityLabel(),
    ...scope,
    ...(sourceHash?.note ? { sourceSha256Note: sourceHash.note } : {}),
    result: {
      boundState: boundState(d),
      statement: precisionLine(d, tauMetres, faithful),
      bounds: [boundRecord(d), boundRecord(faithful)],
      ...(request.lod ? { levelOfDetail: lodRecord(request.lod) } : {}),
    },
    holdsFor: HOLDS_FOR,
    reference: PRECISION_REFERENCE,
    covers: PRECISION_SCOPE,
    scopeDigest: sha256Hex(new TextEncoder().encode(canonical(scope))),
  };
  return JSON.stringify(certificate, null, 2);
}

/** The level selection as the certificate records it, with the claim it supports. */
function lodRecord(s: LodSelection): object {
  return {
    method: methodTag(methodRef(DRAW_PRECISION_LOD_METHOD_ID)),
    rule: 'coarsest level k with sigma * H_k + B_k <= tau, B_k under faithful rounding',
    scope: 'single node: the whole draw; no camera regions, no multi-node selection; the level is selected and certified, not drawn',
    state: s.state,
    level: s.level,
    cellSizeMetres: s.cellSizeMetres,
    hMetres: s.hMetres,
    bMetres: s.bMetres,
    tauMetres: s.tauMetres,
    stretch: s.stretch,
    pointsFull: s.pointsFull,
    pointsKept: s.pointsKept,
    positionBytesFull: s.bytesFull,
    positionBytesKept: s.bytesKept,
    selectionMs: Number(s.selectionMs.toFixed(3)),
    statement: lodLine(s),
    reason: s.reason,
  };
}

/**
 * A precision certificate for the active scan at the current view, as JSON, or
 * null when there is nothing to certify.
 */
export function precisionCertificate(
  deps: PrecisionDeps,
  tauMetres: number,
  now: Date = new Date(),
  sourceHash: SourceHash | null = null,
): string | null {
  const request = capturePrecisionRequest(deps, tauMetres, now, { lod: 'count' });
  return typeof request === 'string' ? null : certificateOf(request, sourceHash);
}

/**
 * The certificate with the scan's whole-file SHA-256, waiting for it when it
 * is still being computed (`onWaiting` says so first). The request is captured
 * before the first wait and the certificate is built from it alone, so the
 * hash and everything beside it describe the same scan and view. Null with
 * nothing open.
 */
export async function precisionCertificateWithHash(
  deps: PrecisionDeps,
  tauMetres: number,
  onWaiting?: () => void,
): Promise<string | null> {
  const request = capturePrecisionRequest(deps, tauMetres, new Date(), { lod: 'count' });
  if (typeof request === 'string') return null;
  if (!sourceDigestReady(request.cloud)) onWaiting?.();
  const { sourceDigestOf } = await loadExportDigests();
  const hash = await sourceDigestOf({ key: request.cloud, streamed: false });
  return certificateOf(request, hash);
}
