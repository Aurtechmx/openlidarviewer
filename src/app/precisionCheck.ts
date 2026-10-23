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
import { methodRef, methodTag } from '../science/methodRegistry';
import { sha256Hex } from '../terrain/export/sha256';
import { buildIdentityLabel } from '../build/buildIdentity';

/** The tolerances the panel offers, in metres. */
export const PRECISION_TOLERANCES: readonly { readonly label: string; readonly metres: number }[] = Object.freeze([
  { label: '1 mm', metres: 0.001 },
  { label: '1 cm', metres: 0.01 },
  { label: '10 cm', metres: 0.1 },
]);

/** What the check covers, stated once for the panel and the certificate. */
export const PRECISION_SCOPE =
  'Where the GPU places each point before projection, not survey accuracy.';

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
}

interface Evaluated {
  readonly cloud: PointCloud;
  readonly tile: DrawTile;
  readonly modelView64: readonly number[];
  readonly diagnostic: DrawPrecisionDiagnostic;
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
  const diagnostic = evaluateDrawPrecision(tile, view, {
    linearUnitKnown: groundMetresPermitted(context),
    linearUnitToMetres: context.linearUnitToMetres,
    verticalUnitToMetres: zUp ? context.verticalUnitToMetres : undefined,
  }, tauMetres);
  return { cloud, tile, modelView64: Array.from(view.modelView64), diagnostic, context };
}

/** A limit as the panel offers it ("1 cm"), or in millimetres when it is not one of those. */
function limitLabel(tauMetres: number): string {
  return PRECISION_TOLERANCES.find((t) => t.metres === tauMetres)?.label ?? formatPrecisionMetres(tauMetres);
}

/** The panel's sentence for a diagnostic. */
export function precisionLine(d: DrawPrecisionDiagnostic, tauMetres: number): string {
  const limit = limitLabel(tauMetres);
  switch (d.state) {
    case 'PASS':
      return `Positions within ${formatPrecisionMetres(d.boundMetres ?? Number.NaN)} at this view, inside the ${limit} limit.`;
    case 'NOT_CERTIFIED':
      return `Positions within ${formatPrecisionMetres(d.boundMetres ?? Number.NaN)} at this view: not certified for the ${limit} limit.`;
    case 'UNGRADED':
      return `Bound ${(d.boundSourceUnits ?? Number.NaN).toPrecision(3)} source units at this view; ${d.reason ?? 'no unit'}, so no limit is checked.`;
    case 'NOT_TESTED':
      return `Not checked: ${d.reason ?? 'the draw is outside the checker domain'}.`;
  }
}

/** Check the active scan at the current view against `tauMetres`. */
export function readPrecision(deps: PrecisionDeps, tauMetres: number): PrecisionReading {
  const e = evaluate(deps, tauMetres);
  if (typeof e === 'string') return { state: 'NO_SCAN', line: e, diagnostic: null };
  return { state: e.diagnostic.state, line: precisionLine(e.diagnostic, tauMetres), diagnostic: e.diagnostic };
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

/** JSON with keys in the order given, so the same scope always hashes the same. */
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * A precision certificate for the active scan at the current view, as JSON, or
 * null when there is nothing to certify. `scopeDigest` is the SHA-256 of the
 * data, frame, draw and requirement it covers: a certificate is void once any
 * of them changes, and two certificates with the same digest cover the same draw.
 */
export function precisionCertificate(deps: PrecisionDeps, tauMetres: number, now: Date = new Date()): string | null {
  const e = evaluate(deps, tauMetres);
  if (typeof e === 'string') return null;
  const { cloud, tile, diagnostic: d, context } = e;
  const scope = {
    dataset: {
      name: cloud.name,
      sourceDigest: cloud.sourceDigest,
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
    draw: {
      strategy: 'model-view composed in binary64 on the CPU, narrowed to binary32 once',
      expression: d.expression,
      backend: d.backend,
      contract: DRAW_PRECISION_CONTRACT,
      modelView64: e.modelView64,
    },
    requirement: { toleranceMetres: tauMetres },
  };
  const certificate = {
    kind: 'olv.draw-precision-certificate',
    version: 1,
    method: methodTag(methodRef(DRAW_PRECISION_METHOD_ID)),
    generatedAt: now.toISOString(),
    build: buildIdentityLabel(),
    ...scope,
    result: {
      boundState: boundState(d),
      boundMetres: d.boundMetres,
      boundSourceUnits: d.boundSourceUnits,
      reason: d.reason,
      statement: precisionLine(d, tauMetres),
    },
    covers: PRECISION_SCOPE,
    scopeDigest: sha256Hex(new TextEncoder().encode(canonical(scope))),
  };
  return JSON.stringify(certificate, null, 2);
}
