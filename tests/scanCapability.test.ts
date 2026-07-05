/**
 * scanCapability.test.ts
 *
 * Pins the descriptor builder and the declared-field -> provenance mapper that
 * connect a live scan to `displayProfile` (v0.5.7 Track B wiring). The declared
 * fields use the exact local names the E57 reader emits for the maintainer's
 * `olv:` block (`accuracyClass`, `license`, `publicationStatus`, …), so this
 * verifies the whole E57 -> descriptor -> profile path without the binary.
 */

import { describe, it, expect } from 'vitest';
import {
  buildCapabilityDescriptor,
  provenanceFromDeclaredFields,
  provenanceCardModel,
  normalizeSourceFormat,
  extentFromBounds,
} from '../src/render/scanCapability';
import { profileFor, profileHeadline, isReferenceGradeProvenance } from '../src/render/displayProfile';
import type { DeclaredMetadataField } from '../src/model/PointCloud';

const OLV = 'https://aurtech.mx/openlidarviewer/metadata/1.0';

/** The Tikal E57's olv: block as the reader delivers it (local names, values). */
const tikalFields: DeclaredMetadataField[] = [
  { name: 'creator', value: 'A. Urias', namespaceUri: OLV },
  { name: 'organization', value: 'Aurtech', namespaceUri: OLV },
  { name: 'license', value: 'CC-BY-4.0', namespaceUri: OLV },
  { name: 'accuracyClass', value: 'reference_based_not_survey_grade', namespaceUri: OLV },
  { name: 'publicationStatus', value: 'research_sample', namespaceUri: OLV },
  { name: 'limitations', value: 'Not photogrammetric, not survey data.', namespaceUri: OLV },
  { name: 'datasetType', value: 'synthetic_reference_reconstruction', namespaceUri: OLV },
  { name: 'sourceBasis', value: 'published height + visual references', namespaceUri: OLV },
];

describe('normalizeSourceFormat', () => {
  it('passes through known formats and coerces the rest to unknown', () => {
    expect(normalizeSourceFormat('e57')).toBe('e57');
    expect(normalizeSourceFormat('glb')).toBe('glb');
    expect(normalizeSourceFormat('pcd')).toBe('unknown');
    expect(normalizeSourceFormat('')).toBe('unknown');
  });
});

describe('extentFromBounds', () => {
  it('computes per-axis extent from min/max', () => {
    expect(extentFromBounds({ min: [-25, -27, 0], max: [25, 27, 47] })).toEqual([50, 54, 47]);
  });
  it('returns undefined for absent or non-finite bounds', () => {
    expect(extentFromBounds(undefined)).toBeUndefined();
    expect(extentFromBounds({ min: [0, 0, 0], max: [Number.NaN, 1, 1] })).toBeUndefined();
  });
});

describe('provenanceFromDeclaredFields', () => {
  it('maps the olv: block to typed provenance (first non-empty wins)', () => {
    const p = provenanceFromDeclaredFields(tikalFields);
    expect(p).toMatchObject({
      creator: 'A. Urias',
      organization: 'Aurtech',
      license: 'CC-BY-4.0',
      accuracyClass: 'reference_based_not_survey_grade',
      publicationStatus: 'research_sample',
    });
    expect(isReferenceGradeProvenance(p)).toBe(true);
  });

  it('falls back from creator to author and ignores empty values', () => {
    const p = provenanceFromDeclaredFields([
      { name: 'author', value: 'J. Doe' },
      { name: 'license', value: '  ' },
    ]);
    expect(p?.creator).toBe('J. Doe');
    expect(p?.license).toBeUndefined();
  });

  it('returns undefined when nothing recognised is present', () => {
    expect(provenanceFromDeclaredFields([])).toBeUndefined();
    expect(provenanceFromDeclaredFields([{ name: 'guid', value: '{123}' }])).toBeUndefined();
    expect(provenanceFromDeclaredFields(undefined)).toBeUndefined();
  });
});

describe('buildCapabilityDescriptor -> profile end to end', () => {
  it('Tikal E57: terrestrial-scan with a reference-grade provenance block', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'e57',
      hasRgb: true,
      hasIntensity: true,
      hasClassification: false,
      hasNormals: false,
      hasGpsTime: false,
      crs: null,
      isMesh: false,
      extentMetres: [50, 54, 47],
      extensionFields: tikalFields,
    });
    expect(profileFor(d)).toBe('terrestrial-scan');
    expect(profileHeadline(d)).toBe('Terrestrial laser scan — local coordinates');
    expect(isReferenceGradeProvenance(d.provenance)).toBe(true);
  });

  it('El Elegante E57 (no olv: block): terrestrial-scan, no provenance', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'e57',
      hasRgb: true,
      hasIntensity: true,
      hasClassification: false,
      hasNormals: false,
      hasGpsTime: false,
      crs: null,
      isMesh: false,
      extentMetres: [3500, 3500, 300],
    });
    expect(profileFor(d)).toBe('terrestrial-scan');
    expect(d.provenance).toBeUndefined();
  });

  it('Statue GLB (textured mesh, no generator): handheld-scan', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'glb',
      hasRgb: false,
      hasIntensity: false,
      hasClassification: false,
      hasNormals: false,
      hasGpsTime: false,
      isMesh: true,
      hasTexture: true,
      extentMetres: [0.608, 0.389, 0.544],
    });
    expect(profileFor(d)).toBe('handheld-scan');
    expect(profileHeadline(d)).toBe('Handheld / object capture — local coordinates');
  });

  it('a georeferenced LAS stays on the geo path', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'las',
      hasRgb: true,
      hasIntensity: true,
      hasClassification: true,
      hasNormals: false,
      hasGpsTime: true,
      crs: { name: 'EPSG:6339' },
    });
    expect(d.isGeoreferenced).toBe(true);
    expect(profileFor(d)).toBe('geo');
  });
});

describe('provenanceCardModel', () => {
  it('builds a full card for the Tikal E57 (headline + declared rows + caveat)', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'e57',
      hasRgb: true,
      hasIntensity: true,
      hasClassification: false,
      hasNormals: false,
      hasGpsTime: false,
      crs: null,
      extentMetres: [50, 54, 47],
      extensionFields: tikalFields,
    });
    const card = provenanceCardModel(d)!;
    expect(card.headline).toBe('Terrestrial laser scan — local coordinates');
    expect(card.referenceGrade).toBe(true);
    expect(card.limitations).toContain('Not photogrammetric');
    const labels = card.declaredRows.map((r) => r.label);
    expect(labels).toEqual(['Creator', 'Organization', 'License', 'Dataset type', 'Accuracy class', 'Source basis']);
    const license = card.declaredRows.find((r) => r.label === 'License');
    expect(license?.value).toBe('CC-BY-4.0');
  });

  it('shows a headline with no declared rows for a handheld scan', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'glb',
      hasRgb: false,
      hasIntensity: false,
      hasClassification: false,
      hasNormals: false,
      hasGpsTime: false,
      isMesh: true,
      hasTexture: true,
      extentMetres: [0.6, 0.4, 0.5],
    });
    const card = provenanceCardModel(d)!;
    expect(card.headline).toBe('Handheld / object capture — local coordinates');
    expect(card.declaredRows).toEqual([]);
    expect(card.referenceGrade).toBe(false);
  });

  it('returns null for the unchanged geo path with no provenance', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'las',
      hasRgb: true,
      hasIntensity: true,
      hasClassification: true,
      hasNormals: false,
      hasGpsTime: true,
      crs: { name: 'EPSG:6339' },
    });
    expect(provenanceCardModel(d)).toBeNull();
  });
});
