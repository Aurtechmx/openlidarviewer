/**
 * CrsDetection.ts
 *
 * Aggregate every CRS signal the platform has for a loaded
 * dataset (LAS/LAZ VLR, COPC info VLR, EPT manifest, STAC catalog tile
 * metadata, user override) into a single `ResolvedCrs` with documented
 * provenance and confidence. Pure, unit-testable in Node — no three.js,
 * no DOM, no `localStorage`.
 *
 * Priority order (highest wins):
 *
 *   1. **user-override** — the analyst's explicit choice from the
 *      Inspector. Always wins. `userConfirmed = true`.
 *   2. **catalog-tile** — STAC `proj:epsg` from a Planetary Computer
 *      search result. Trusted because the catalog publishes a verified
 *      EPSG per tile. When it AGREES with the VLR, confidence climbs
 *      to `'high'`; when they DISAGREE, we return the catalog value but
 *      demote confidence to `'medium'` and surface a `conflict` flag.
 *   3. **las-vlr / copc-meta / ept-srs** — the VLR-equivalent path
 *      every format eventually walks. The same `CrsInfo` shape; the
 *      `source` label is set by the caller.
 *   4. **default-assumption** — last-resort hint when nothing else
 *      surfaced. Useful for COPC's "if hasRgb assume WebMercator
 *      EPSG:3857" guess, though we don't ship one today. Always
 *      `'low'` confidence.
 *
 * The pure-data shape of `CrsSignals` lets every loader (LAS, COPC,
 * EPT) construct it from the metadata it already has. The Viewer's
 * top-level "what CRS are we in?" reads exactly one place — this
 * function — so a future signal (e.g. a `cesium:CRS` 3D Tiles tag)
 * plugs in by adding one field here and one branch below.
 */

import type {
  CrsConfidence,
  CrsKind,
  CrsSource,
  ResolvedCrs,
} from './CoordinateTypes';
import type { CrsInfo } from '../io/crs';
import type { CrsOverride } from './CrsOverrideStore';

/** The bundle of CRS signals a dataset may surface. All fields optional. */
export interface CrsSignals {
  /** Parsed VLR / manifest CRS info from LAS / COPC / EPT. */
  readonly vlr?: CrsInfo;
  /**
   * Which VLR family the `vlr` came from. Drives the `source` label on
   * the resolved CRS; ignored when `vlr` is absent.
   */
  readonly vlrSource?: 'las-vlr' | 'copc-meta' | 'ept-srs';
  /**
   * STAC catalog tile EPSG, when the dataset was opened from a catalog
   * search — a first-class detector signal.
   */
  readonly catalogEpsg?: number;
  /** Human-friendly catalog source label (e.g. "Planetary Computer"). */
  readonly catalogLabel?: string;
  /** A user override loaded from `CrsOverrideStore`. */
  readonly override?: CrsOverride;
  /**
   * A default-assumption EPSG to use when every other signal is absent.
   * For example, a 3D Tiles tileset whose tileset.json omits CRS would
   * default to ECEF (EPSG:4978). Optional; the detector returns an
   * `'unknown'` resolved when nothing surfaced.
   */
  readonly defaultEpsg?: number;
  /** Dataset's friendly name, used as a last-resort label. */
  readonly datasetName?: string;
}

/** Output: a resolved CRS plus a flag the inspector can surface when the signals disagreed. */
export interface CrsDetectionResult {
  readonly resolved: ResolvedCrs;
  /**
   * True when the catalog-tile EPSG and the VLR EPSG were both present
   * AND disagreed. The Inspector surfaces this as a "CRS conflict —
   * please confirm" warning; the report's Methods appendix records it.
   */
  readonly conflict: boolean;
  /**
   * All signals the detector considered, in priority order. Surfaced in
   * the Inspector's "What did we detect?" disclosure so the user can
   * trace why the resolved CRS reads the way it does.
   */
  readonly considered: ReadonlyArray<{
    readonly source: CrsSource;
    readonly epsg?: number;
    readonly note?: string;
  }>;
}

/**
 * Aggregate the signals into a single resolved CRS. Pure: no I/O, no
 * mutation. See the module docstring for the priority + confidence
 * rules.
 */
export function detectCrs(signals: CrsSignals): CrsDetectionResult {
  const considered: Array<{ source: CrsSource; epsg?: number; note?: string }> = [];

  // 1. ── user-override wins ───────────────────────────────────────────
  if (signals.override) {
    const ov = signals.override;
    considered.push({
      source: 'user-override',
      epsg: ov.epsg ?? undefined,
      note: 'analyst chose this from the Inspector override panel',
    });
    return {
      resolved: resolvedFromOverride(ov, signals.datasetName, signals.vlr),
      conflict: false,
      considered,
    };
  }

  // 2. ── catalog-tile signal ──────────────────────────────────────────
  if (signals.catalogEpsg != null) {
    considered.push({
      source: 'catalog-tile',
      epsg: signals.catalogEpsg,
      note: signals.catalogLabel ?? 'catalog tile metadata',
    });
  }

  // 3. ── VLR signal ───────────────────────────────────────────────────
  if (signals.vlr) {
    const vlrSource = signals.vlrSource ?? 'las-vlr';
    considered.push({
      source: vlrSource,
      epsg: signals.vlr.epsg,
      note: signals.vlr.name,
    });
  }

  // ── Conflict detection ─────────────────────────────────────────────
  let conflict = false;
  if (
    signals.catalogEpsg != null &&
    signals.vlr?.epsg != null &&
    signals.catalogEpsg !== signals.vlr.epsg
  ) {
    conflict = true;
  }

  // ── Resolve the winner ─────────────────────────────────────────────
  if (signals.catalogEpsg != null) {
    // Catalog wins over VLR. Confidence is HIGH when they agree, MEDIUM
    // when they disagree (the demotion forces the Inspector to surface
    // a confirmation), still HIGH when no VLR is present (catalog alone
    // is trusted).
    const agree = signals.vlr?.epsg === signals.catalogEpsg;
    const noVlr = signals.vlr?.epsg == null;
    const confidence: CrsConfidence = agree || noVlr ? 'high' : 'medium';
    return {
      resolved: resolvedFromCatalog(
        signals.catalogEpsg,
        signals.catalogLabel,
        signals.vlr,
        confidence,
      ),
      conflict,
      considered,
    };
  }

  if (signals.vlr) {
    return {
      resolved: resolvedFromVlr(
        signals.vlr,
        signals.vlrSource ?? 'las-vlr',
        confidenceForVlr(signals.vlr),
      ),
      conflict: false,
      considered,
    };
  }

  // 4. ── default-assumption fallback ─────────────────────────────────
  if (signals.defaultEpsg != null) {
    considered.push({
      source: 'default-assumption',
      epsg: signals.defaultEpsg,
      note: 'no metadata; using documented format default',
    });
    return {
      resolved: resolvedFromDefault(signals.defaultEpsg, signals.datasetName),
      conflict: false,
      considered,
    };
  }

  // 5. ── nothing surfaced — unknown ───────────────────────────────────
  return {
    resolved: {
      kind: 'unknown',
      name: signals.datasetName ?? 'Unknown CRS',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      source: 'default-assumption',
      confidence: 'none',
      userConfirmed: false,
    },
    conflict: false,
    considered,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function confidenceForVlr(vlr: CrsInfo): CrsConfidence {
  const hasEpsg = vlr.epsg != null;
  const hasWkt = (vlr.wkt ?? '').trim().length > 0;
  if (hasEpsg && hasWkt) return 'high';
  if (hasEpsg || hasWkt) return 'medium';
  return 'low';
}

function kindFromIsGeographic(isGeographic: boolean | undefined): CrsKind {
  if (isGeographic === true) return 'geographic';
  if (isGeographic === false) return 'projected';
  return 'unknown';
}

function resolvedFromOverride(
  ov: CrsOverride,
  _datasetName: string | undefined,
  vlr: CrsInfo | undefined,
): ResolvedCrs {
  // The override stores `epsg | null` (null = "treat as local"). When
  // null we return a local-coordinate resolved; otherwise we carry the
  // EPSG forward and lean on the VLR's labels when available so the
  // Inspector still shows a human name.
  if (ov.epsg == null) {
    return {
      kind: 'local',
      name: 'Local coordinates (no CRS)',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      source: 'user-override',
      confidence: 'high',
      userConfirmed: true,
    };
  }
  const name = vlr?.name && vlr.epsg === ov.epsg ? vlr.name : `EPSG:${ov.epsg}`;
  return {
    kind: ov.kind === 'local' ? 'local' : ov.kind,
    name,
    epsg: ov.epsg,
    linearUnit: vlr?.linearUnit ?? 'metre',
    linearUnitToMetres: vlr?.linearUnitToMetres ?? 1,
    source: 'user-override',
    confidence: 'high',
    userConfirmed: true,
    wkt: vlr?.wkt,
  };
}

function resolvedFromCatalog(
  epsg: number,
  _catalogLabel: string | undefined,
  vlr: CrsInfo | undefined,
  confidence: CrsConfidence,
): ResolvedCrs {
  // Lean on the VLR's labels when EPSG agrees, otherwise fall back to
  // the EPSG bareword. The Inspector renders the catalog label in the
  // disclosure ("via Planetary Computer") so the user knows the source.
  const useVlrName = vlr?.epsg === epsg && vlr.name;
  return {
    kind: kindFromIsGeographic(vlr?.isGeographic),
    name: useVlrName ? vlr.name : `EPSG:${epsg}`,
    epsg,
    linearUnit: vlr?.linearUnit ?? 'metre',
    linearUnitToMetres: vlr?.linearUnitToMetres ?? 1,
    source: 'catalog-tile',
    confidence,
    userConfirmed: false,
    wkt: vlr?.wkt,
  };
}

function resolvedFromVlr(
  vlr: CrsInfo,
  source: 'las-vlr' | 'copc-meta' | 'ept-srs',
  confidence: CrsConfidence,
): ResolvedCrs {
  return {
    kind: kindFromIsGeographic(vlr.isGeographic),
    name: vlr.name,
    epsg: vlr.epsg,
    linearUnit: vlr.linearUnit,
    linearUnitToMetres: vlr.linearUnitToMetres,
    source,
    confidence,
    userConfirmed: false,
    wkt: vlr.wkt,
  };
}

function resolvedFromDefault(epsg: number, _datasetName: string | undefined): ResolvedCrs {
  return {
    kind: 'projected',
    name: `EPSG:${epsg}`,
    epsg,
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'default-assumption',
    confidence: 'low',
    userConfirmed: false,
  };
}
