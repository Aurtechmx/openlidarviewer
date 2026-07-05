/**
 * scanCapability.ts
 *
 * Builds the pure {@link CapabilityDescriptor} that `displayProfile` consumes,
 * from a live scan's state, and maps a file's declared extension-namespace
 * fields into a {@link ScanProvenance} block. Kept separate from the panels and
 * from `displayProfile` itself so the mapping is unit-tested without a DOM or a
 * real `PointCloud` — the inputs are plain structural objects.
 *
 * The E57 reader already de-pages the CRC-paged file and collects the `olv:`
 * (or any extension-namespace) fields into `metadata.sourceMetadata.extensions`
 * as `{ name, value, namespaceUri? }`; this module turns those declared fields
 * into the typed provenance the terrestrial-scan profile surfaces. Everything
 * here is declared-by-the-file, never inferred.
 */

import type { DeclaredMetadataField } from '../model/PointCloud';
import type { CapabilityDescriptor, ScanProvenance, SourceFormat } from './displayProfile';

/** Source-format strings `displayProfile` understands. */
const KNOWN_FORMATS: ReadonlySet<string> = new Set<SourceFormat>([
  'las', 'laz', 'copc', 'ept', 'e57', 'ptx', 'pts', 'obj', 'glb', 'gltf', 'ply', 'xyz', 'csv',
]);

/** Coerce any format string to a known {@link SourceFormat}, else `'unknown'`. */
export function normalizeSourceFormat(fmt: string): SourceFormat {
  return KNOWN_FORMATS.has(fmt) ? (fmt as SourceFormat) : 'unknown';
}

/**
 * Map declared extension fields (local name -> value) to a {@link ScanProvenance}.
 * The first non-empty occurrence of each field wins; `creator` falls back to
 * `author`. Matching is on the local field name, case-insensitively, so an
 * `olv:accuracyClass` element arrives here as `accuracyClass`. Returns
 * `undefined` when none of the recognised fields are present.
 */
export function provenanceFromDeclaredFields(
  fields: readonly DeclaredMetadataField[] | undefined,
): ScanProvenance | undefined {
  if (!fields || fields.length === 0) return undefined;

  const first = (names: readonly string[]): string | undefined => {
    for (const wanted of names) {
      const hit = fields.find(
        (f) => f.name.toLowerCase() === wanted && f.value.trim() !== '',
      );
      if (hit) return hit.value.trim();
    }
    return undefined;
  };

  const prov: Record<string, string | undefined> = {
    creator: first(['creator', 'author']),
    organization: first(['organization']),
    license: first(['license']),
    title: first(['title']),
    accuracyClass: first(['accuracyclass']),
    publicationStatus: first(['publicationstatus']),
    limitations: first(['limitations']),
    datasetType: first(['datasettype']),
    sourceBasis: first(['sourcebasis']),
  };

  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(prov)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length > 0 ? (out as ScanProvenance) : undefined;
}

/** Extent [x, y, z] in metres from an axis-aligned bounds min/max, or undefined. */
export function extentFromBounds(
  bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] } | undefined,
): [number, number, number] | undefined {
  if (!bounds) return undefined;
  const e: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  return e.every((v) => Number.isFinite(v)) ? e : undefined;
}

/**
 * The scan state the descriptor is built from. A structural shape (not the
 * `PointCloud` class) so tests supply plain objects and the wiring passes a few
 * accessor reads.
 */
export interface ScanCapabilityInput {
  readonly sourceFormat: string;
  readonly hasRgb: boolean;
  readonly hasIntensity: boolean;
  readonly hasClassification: boolean;
  readonly hasNormals: boolean;
  readonly hasGpsTime: boolean;
  /** A resolved CRS makes the scan georeferenced; null/undefined = local frame. */
  readonly crs?: unknown | null;
  readonly isMesh?: boolean;
  readonly hasTexture?: boolean;
  readonly extentMetres?: readonly [number, number, number];
  readonly generator?: string;
  /** Declared extension-namespace fields (E57 `olv:` block, etc.). */
  readonly extensionFields?: readonly DeclaredMetadataField[];
}

/** Assemble a {@link CapabilityDescriptor} from a scan's state. Pure. */
export function buildCapabilityDescriptor(input: ScanCapabilityInput): CapabilityDescriptor {
  const provenance = provenanceFromDeclaredFields(input.extensionFields);
  return {
    sourceFormat: normalizeSourceFormat(input.sourceFormat),
    hasRgb: input.hasRgb,
    hasIntensity: input.hasIntensity,
    hasClassification: input.hasClassification,
    hasNormals: input.hasNormals,
    hasGpsTime: input.hasGpsTime,
    isGeoreferenced: input.crs != null,
    isMesh: input.isMesh === true,
    ...(input.hasTexture !== undefined ? { hasTexture: input.hasTexture } : {}),
    ...(input.extentMetres ? { extentMetres: input.extentMetres } : {}),
    ...(input.generator ? { generator: input.generator } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
