/**
 * displayProfile.ts
 *
 * Capability-driven panel profiles (v0.5.7 Track B). A file should only show the
 * sections it can actually support: an E57 terrestrial scan has no ASPRS
 * classification, no CRS/datum, and no USGS Quality Level, so those rows are
 * noise; a handheld/object capture additionally has no intensity and no survey
 * density. This module maps a pure capability descriptor to a display profile
 * and a section-visibility table.
 *
 * Pure data in, enum + booleans out — no DOM, no `Viewer`, no three.js — so it
 * is fully unit-tested (see tests/displayProfile.test.ts) against synthetic
 * descriptors that reproduce the maintainer's real sample fingerprints. The
 * wiring (AnalysePanel / Inspector) builds the descriptor from live scan state.
 *
 * Scope: adds terrestrial-scan (E57/PTX/PTS), handheld-scan (phone/app object
 * captures), and mesh (OBJ/GLB/PLY-mesh) profiles. Everything else maps to
 * `geo`, which means "the existing survey/default path, unchanged" — the
 * LAS/LAZ/COPC/EPT experience is untouched.
 */

/** The four display profiles. `geo` is the unchanged default/survey path. */
export type DisplayProfile = 'geo' | 'terrestrial-scan' | 'handheld-scan' | 'mesh';

/** Source container the scan was decoded from (lower-case, extension-like). */
export type SourceFormat =
  | 'las'
  | 'laz'
  | 'copc'
  | 'ept'
  | 'e57'
  | 'ptx'
  | 'pts'
  | 'obj'
  | 'glb'
  | 'gltf'
  | 'ply'
  | 'xyz'
  | 'csv'
  | 'unknown';

/**
 * Provenance metadata a file may embed. Modelled on the maintainer's
 * `olv:` E57 namespace (https://aurtech.mx/openlidarviewer/metadata/1.0) but
 * kept generic so any source can supply it.
 */
export interface ScanProvenance {
  readonly creator?: string;
  readonly organization?: string;
  readonly license?: string;
  readonly title?: string;
  readonly accuracyClass?: string;
  readonly publicationStatus?: string;
  readonly limitations?: string;
  readonly datasetType?: string;
  readonly sourceBasis?: string;
}

/** Everything the profile decision needs, derived once at load. */
export interface CapabilityDescriptor {
  readonly sourceFormat: SourceFormat;
  readonly hasRgb: boolean;
  readonly hasIntensity: boolean;
  readonly hasClassification: boolean;
  readonly hasNormals: boolean;
  readonly hasGpsTime: boolean;
  /** A known CRS/EPSG resolved (the scan is placed on Earth). */
  readonly isGeoreferenced: boolean;
  /** Carries face/triangle topology (a mesh, not a pure point cloud). */
  readonly isMesh: boolean;
  /** Colour comes from a bound texture + UVs rather than per-vertex RGB. */
  readonly hasTexture?: boolean;
  /** Metric bounding-box extent [x, y, z] in metres, when known. */
  readonly extentMetres?: readonly [number, number, number];
  /** Generator/source hint: glTF `asset.generator`, PLY/OBJ header comment. */
  readonly generator?: string;
  /** Embedded provenance metadata, when present. */
  readonly provenance?: ScanProvenance;
}

/**
 * Sections the panels can show or hide per profile. Names are intentionally
 * capability-oriented (what the data supports), not layout-oriented.
 */
export type SectionId =
  | 'pointCount'
  | 'density'
  | 'surveyDensityFraming'
  | 'bounds'
  | 'scale'
  | 'rgbColour'
  | 'intensityColour'
  | 'normalsColour'
  | 'texturedColour'
  | 'classification'
  | 'crsDatum'
  | 'usgsQualityLevel'
  | 'groundCoverage'
  | 'dtmContours'
  | 'verticalAccuracy'
  | 'measure'
  | 'clip'
  | 'sectionProfile'
  | 'perPointReadout'
  | 'provenanceCard';

/**
 * Formats treated as survey point clouds — the unchanged `geo` path. COPC/EPT
 * are the streaming variants; LAS/LAZ the static ones.
 */
const SURVEY_FORMATS: ReadonlySet<SourceFormat> = new Set(['las', 'laz', 'copc', 'ept']);

/** Formats treated as terrestrial laser scans (no ASPRS class, no CRS). */
const TERRESTRIAL_FORMATS: ReadonlySet<SourceFormat> = new Set(['e57', 'ptx', 'pts']);

/** Container formats a mesh or handheld capture arrives in. */
const MESH_CONTAINER_FORMATS: ReadonlySet<SourceFormat> = new Set(['obj', 'glb', 'gltf', 'ply']);

/**
 * Upper bound (metres) on the largest extent axis for the geometry-only
 * handheld signal. A room or object is single-digit to low-tens of metres;
 * anything larger is a site/terrain mesh and stays in the `mesh` profile. A
 * generator match overrides this (a large Polycam scan is still handheld).
 */
export const HANDHELD_MAX_EXTENT_M = 50;

/**
 * Known capture-app generator signatures (lower-case substrings) and the
 * display name to attribute. Grounded in the apps that stamp glTF
 * `asset.generator` / PLY-OBJ comments; extend as real exports are seen.
 */
const CAPTURE_GENERATORS: ReadonlyArray<{ readonly match: string; readonly name: string }> = [
  { match: 'polycam', name: 'Polycam' },
  { match: 'scaniverse', name: 'Scaniverse' },
  { match: '3d scanner app', name: '3D Scanner App' },
  { match: 'sitescape', name: 'SiteScape' },
  { match: 'trnio', name: 'Trnio' },
  { match: 'kiri', name: 'KIRI Engine' },
  { match: 'metascan', name: 'Metascan' },
  { match: 'heges', name: 'Heges' },
  { match: 'realitykit', name: 'RealityKit' },
  { match: 'roomplan', name: 'RoomPlan' },
  { match: 'luma', name: 'Luma' },
];

export type DetectionConfidence = 'high' | 'low' | 'none';

export interface HandheldDetection {
  readonly isHandheld: boolean;
  /** `high` = named generator match; `low` = geometry/structure only. */
  readonly confidence: DetectionConfidence;
  /** The attributed app when a generator matched (high confidence only). */
  readonly source?: string;
  /** Human-readable explanation of the decision. */
  readonly reason: string;
}

function allFinitePositiveExtent(extent: readonly [number, number, number] | undefined): boolean {
  if (!extent) return false;
  const max = Math.max(...extent);
  return extent.every((v) => Number.isFinite(v) && v >= 0) && max > 0 && Number.isFinite(max);
}

/**
 * Decide whether a mesh/point container is a handheld or object capture.
 *
 * A generator match is high confidence and names the app. Otherwise the
 * geometry/structure fingerprint of the maintainer's real samples — a
 * textured or RGB-coloured, object/room-scale, non-georeferenced container with
 * no intensity / classification / GPS time — is low confidence and yields the
 * neutral "object capture" framing. Anything else is not a handheld scan.
 */
export function detectHandheld(d: CapabilityDescriptor): HandheldDetection {
  const gen = (d.generator ?? '').toLowerCase().trim();
  if (gen) {
    const hit = CAPTURE_GENERATORS.find((g) => gen.includes(g.match));
    if (hit) {
      return {
        isHandheld: true,
        confidence: 'high',
        source: hit.name,
        reason: `generator identifies ${hit.name}`,
      };
    }
  }

  const capContainer = MESH_CONTAINER_FORMATS.has(d.sourceFormat);
  const coloured = d.hasTexture === true || d.hasRgb;
  const objectScale = allFinitePositiveExtent(d.extentMetres)
    && Math.max(...(d.extentMetres as readonly [number, number, number])) <= HANDHELD_MAX_EXTENT_M;
  const noSurvey = !d.isGeoreferenced && !d.hasClassification && !d.hasIntensity && !d.hasGpsTime;

  if (capContainer && coloured && objectScale && noSurvey) {
    return {
      isHandheld: true,
      confidence: 'low',
      reason: 'object-scale coloured mesh with no survey attributes',
    };
  }
  return {
    isHandheld: false,
    confidence: 'none',
    reason: 'no generator match and geometry is not capture-shaped',
  };
}

/**
 * Map a capability descriptor to a display profile.
 *
 * Order matters: survey formats stay `geo` (unchanged); a georeferenced E57 is
 * also `geo` (it can support the CRS rows a bare terrestrial scan cannot);
 * bare terrestrial formats become `terrestrial-scan`; mesh containers split into
 * `handheld-scan` vs `mesh` by {@link detectHandheld}; everything else is `geo`.
 */
export function profileFor(d: CapabilityDescriptor): DisplayProfile {
  if (SURVEY_FORMATS.has(d.sourceFormat)) return 'geo';

  if (TERRESTRIAL_FORMATS.has(d.sourceFormat)) {
    // A terrestrial scan that genuinely carries a CRS keeps the full geo path so
    // its CRS/datum rows are not hidden; only local-frame scans are decluttered.
    return d.isGeoreferenced ? 'geo' : 'terrestrial-scan';
  }

  if (MESH_CONTAINER_FORMATS.has(d.sourceFormat)) {
    if (detectHandheld(d).isHandheld) return 'handheld-scan';
    if (d.isMesh) return 'mesh';
    // A plain PLY/OBJ point cloud that isn't capture-shaped: leave the default
    // path unchanged rather than force a mesh profile onto point data.
    return 'geo';
  }

  return 'geo';
}

/**
 * Sections hidden per profile. `geo` hides nothing (shows everything today).
 * `sectionVisible` returns the complement.
 */
const HIDDEN_SECTIONS: Record<DisplayProfile, ReadonlySet<SectionId>> = {
  geo: new Set<SectionId>(),
  'terrestrial-scan': new Set<SectionId>([
    'classification',
    'crsDatum',
    'usgsQualityLevel',
    'groundCoverage',
    'dtmContours',
    'verticalAccuracy',
    'surveyDensityFraming',
  ]),
  'handheld-scan': new Set<SectionId>([
    'intensityColour',
    'classification',
    'crsDatum',
    'usgsQualityLevel',
    'groundCoverage',
    'dtmContours',
    'verticalAccuracy',
    'surveyDensityFraming',
    'density',
  ]),
  mesh: new Set<SectionId>([
    'intensityColour',
    'classification',
    'crsDatum',
    'usgsQualityLevel',
    'groundCoverage',
    'dtmContours',
    'verticalAccuracy',
    'surveyDensityFraming',
    'density',
    'provenanceCard',
  ]),
};

/** Whether `section` should be shown under `profile`. */
export function sectionVisible(profile: DisplayProfile, section: SectionId): boolean {
  return !HIDDEN_SECTIONS[profile].has(section);
}

/**
 * The one-line headline for the profile. States facts rather than defects: a
 * local-coordinate terrestrial scan is "local coordinates", not "not placed on
 * Earth". Never asserts a device the file does not prove — a geometry-only
 * (low-confidence) handheld stays neutral "object capture".
 */
export function profileHeadline(d: CapabilityDescriptor): string {
  const profile = profileFor(d);
  switch (profile) {
    case 'terrestrial-scan':
      return 'Terrestrial laser scan — local coordinates';
    case 'handheld-scan': {
      const det = detectHandheld(d);
      if (det.confidence === 'high' && det.source) {
        return `Handheld LiDAR scan (${det.source}) — local coordinates`;
      }
      return 'Handheld / object capture — local coordinates';
    }
    case 'mesh':
      return 'Mesh — local coordinates';
    case 'geo':
    default:
      return '';
  }
}

/**
 * Whether an embedded provenance block declares the scan is not survey grade,
 * so the wiring can suppress any survey-grade framing and show the caveat. Honors
 * the maintainer's `accuracyClass=reference_based_not_survey_grade` and a
 * research/sample publication status.
 */
export function isReferenceGradeProvenance(p: ScanProvenance | undefined): boolean {
  if (!p) return false;
  const accuracy = (p.accuracyClass ?? '').toLowerCase();
  const status = (p.publicationStatus ?? '').toLowerCase();
  return (
    accuracy.includes('not_survey_grade')
    || accuracy.includes('not survey grade')
    || accuracy.includes('reference')
    || status.includes('research')
    || status.includes('sample')
  );
}
