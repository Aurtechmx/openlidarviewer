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
  evaluateDrawPrecision,
  tileFromLocalFloat32,
  type DrawPrecisionDiagnostic,
  type DrawTile,
} from '../science/drawPrecision';
import { drawPrecisionViewFor, type DrawPrecisionViewer } from './drawPrecisionView';
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
}

interface Evaluated {
  readonly cloud: PointCloud;
  readonly tile: DrawTile;
  readonly modelView64: readonly number[];
  /** Round to nearest: the contract the limit is checked under. */
  readonly diagnostic: DrawPrecisionDiagnostic;
  /** The faithful rounding the WGSL and GLSL ES specs guarantee: the worst case. */
  readonly faithful: DrawPrecisionDiagnostic;
  readonly context: SpatialContext;
}

function evaluate(deps: PrecisionDeps, tauMetres: number): Evaluated | string {
  const viewer = deps.viewer();
  const cloud = deps.activeCloud();
  if (!viewer || !cloud) return 'Open a scan to check its precision.';
  const view = drawPrecisionViewFor(viewer, deps.activeId(), cloud);
  if (!view) return 'The check covers a loaded scan; a streamed scan is not checked.';
  const context = deps.context();
  const upFrame = layerUpFrameFromContext(cloud.sourceFormat, context);
  const zUp = upFrame.ok && upFrame.axis === 'z';
  const tile = tileFromLocalFloat32(sourcePositions(cloud));
  const unit = {
    linearUnitKnown: groundMetresPermitted(context),
    linearUnitToMetres: context.linearUnitToMetres,
    verticalUnitToMetres: zUp ? context.verticalUnitToMetres : undefined,
  };
  return {
    cloud,
    tile,
    modelView64: Array.from(view.modelView64),
    diagnostic: evaluateDrawPrecision(tile, view, unit, tauMetres, 'rn'),
    faithful: evaluateDrawPrecision(tile, view, unit, tauMetres, 'faithful'),
    context,
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

/** Check the active scan at the current view against `tauMetres`. */
export function readPrecision(deps: PrecisionDeps, tauMetres: number): PrecisionReading {
  const e = evaluate(deps, tauMetres);
  if (typeof e === 'string') return { state: 'NO_SCAN', line: e, diagnostic: null, pointsDrawn: 0 };
  return { state: e.diagnostic.state, line: precisionLine(e.diagnostic, tauMetres, e.faithful), diagnostic: e.diagnostic, pointsDrawn: e.cloud.pointCount };
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

/**
 * A precision certificate for the active scan at the current view, as JSON, or
 * null when there is nothing to certify. It records both contracts' bounds
 * with the checker's evidence, the drawn points, the camera and the scan's
 * hash, so the claim is no wider than the bound: these points, this camera,
 * this contract and shader. `scopeDigest` is the SHA-256 of that scope: a
 * certificate is void once any of it changes, and two certificates with the
 * same digest cover the same draw.
 */
export function precisionCertificate(
  deps: PrecisionDeps,
  tauMetres: number,
  now: Date = new Date(),
  sourceHash: SourceHash | null = null,
): string | null {
  const e = evaluate(deps, tauMetres);
  if (typeof e === 'string') return null;
  const { cloud, tile, diagnostic: d, faithful, context } = e;
  const scope = {
    dataset: {
      name: cloud.name,
      sourceSha256: sourceHash?.sha256 ?? null,
      sourceFingerprint: cloud.sourceDigest,
      pointsDrawn: cloud.pointCount,
      declaredPoints: cloud.declaredPointCount ?? cloud.pointCount,
    },
    frame: {
      crs: context.epsg ?? null,
      linearUnitToMetres: context.linearUnitToMetres,
      origin: [...cloud.sourceOrigin],
      localExtent: [...tile.r],
      storageErrorBound: [...tile.rho],
      storageBasis: tile.basis,
    },
    camera: {
      positionInScanCoordinates: cameraPositionOf(e.modelView64, cloud.sourceOrigin),
      modelView64: e.modelView64,
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
    version: 2,
    method: methodTag(methodRef(DRAW_PRECISION_METHOD_ID)),
    citation: method(DRAW_PRECISION_METHOD_ID)?.citation ?? null,
    generatedAt: now.toISOString(),
    build: buildIdentityLabel(),
    ...scope,
    ...(sourceHash?.note ? { sourceSha256Note: sourceHash.note } : {}),
    result: {
      boundState: boundState(d),
      statement: precisionLine(d, tauMetres, faithful),
      bounds: [boundRecord(d), boundRecord(faithful)],
    },
    holdsFor: `The ${cloud.pointCount} points drawn, from this camera, under the stated contract and shader expression; any other draw needs its own check.`,
    reference: PRECISION_REFERENCE,
    covers: PRECISION_SCOPE,
    scopeDigest: sha256Hex(new TextEncoder().encode(canonical(scope))),
  };
  return JSON.stringify(certificate, null, 2);
}

/**
 * The certificate with the scan's whole-file SHA-256, waiting for it when it
 * is still being computed (`onWaiting` says so first). Null with nothing open.
 */
export async function precisionCertificateWithHash(
  deps: PrecisionDeps,
  tauMetres: number,
  onWaiting?: () => void,
): Promise<string | null> {
  const cloud = deps.activeCloud();
  if (!cloud) return null;
  if (!sourceDigestReady(cloud)) onWaiting?.();
  const { sourceDigestOf } = await loadExportDigests();
  const hash = await sourceDigestOf({ key: cloud, streamed: false });
  return precisionCertificate(deps, tauMetres, new Date(), hash);
}
