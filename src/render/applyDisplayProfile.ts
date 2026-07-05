/**
 * applyDisplayProfile.ts
 *
 * Lazy seam for the v0.5.7 capability-driven panel wiring. Loaded via
 * `lazyChunks` on scan open, NOT eagerly: the profile only matters once a scan
 * is loaded, and importing `displayProfile` + `scanCapability` into the startup
 * shell pushed the eager `index` chunk over its bundle budget. Keeping the
 * derivation here holds those modules out of the initial payload.
 */

import type { PointCloud } from '../model/PointCloud';
import {
  buildCapabilityDescriptor,
  extentFromBounds,
  provenanceCardModel,
  type ProvenanceCardModel,
} from './scanCapability';
import { profileFor, sectionVisible } from './displayProfile';

/**
 * The Inspector surface this wiring touches. Structural (not the concrete
 * `Inspector`) so this lazy module doesn't drag the panel into its chunk.
 */
export interface DisplayProfileTarget {
  setDeclaredProvenance(model: ProvenanceCardModel | null): void;
  setCrsSectionVisible(visible: boolean): void;
}

/**
 * Derive the display profile from a freshly-loaded scan and apply it to the
 * Inspector: surface the declared-by-the-file provenance card (E57 `olv:` block
 * + profile headline) and hide the Coordinate-system section for local-frame
 * profiles (a bare E57 / handheld / mesh scan has no geodetic CRS to show).
 */
export function applyDisplayProfile(cloud: PointCloud, target: DisplayProfileTarget): void {
  const descriptor = buildCapabilityDescriptor({
    sourceFormat: cloud.sourceFormat,
    hasRgb: cloud.colors !== undefined,
    hasIntensity: cloud.intensity !== undefined,
    hasClassification: cloud.classification !== undefined,
    hasNormals: cloud.normals !== undefined,
    hasGpsTime: cloud.gpsTime !== undefined,
    crs: cloud.metadata?.crs,
    isMesh:
      cloud.sourceFormat === 'obj'
      || cloud.sourceFormat === 'glb'
      || cloud.sourceFormat === 'gltf',
    hasTexture: cloud.metadata?.hasTexture,
    extentMetres: extentFromBounds(cloud.bounds()),
    generator: cloud.metadata?.sourceSoftware,
    extensionFields: cloud.metadata?.sourceMetadata?.extensions,
  });
  target.setDeclaredProvenance(provenanceCardModel(descriptor));
  target.setCrsSectionVisible(sectionVisible(profileFor(descriptor), 'crsDatum'));
}
