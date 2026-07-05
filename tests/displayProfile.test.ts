/**
 * displayProfile.test.ts
 *
 * Pins the pure capability-driven profile logic (v0.5.7 Track B). The synthetic
 * descriptors reproduce the maintainer's real sample fingerprints so CI never
 * depends on the multi-MB binaries:
 *   - Tikal / El Elegante E57: XYZ + intensity + RGB, Z-up, no CRS (terrestrial);
 *     the Tikal file also carries the `olv:` provenance block.
 *   - Statue1/2 GLB: textured triangle mesh, no vertex RGB/normals, no generator,
 *     object-scale, no survey attributes (handheld / object capture).
 */

import { describe, it, expect } from 'vitest';
import {
  profileFor,
  detectHandheld,
  sectionVisible,
  profileHeadline,
  isReferenceGradeProvenance,
  HANDHELD_MAX_EXTENT_M,
  type CapabilityDescriptor,
  type SectionId,
} from '../src/render/displayProfile';

function desc(over: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    sourceFormat: 'unknown',
    hasRgb: false,
    hasIntensity: false,
    hasClassification: false,
    hasNormals: false,
    hasGpsTime: false,
    isGeoreferenced: false,
    isMesh: false,
    ...over,
  };
}

// --- Real-sample-shaped fixtures --------------------------------------------

const surveyCopc = desc({
  sourceFormat: 'copc',
  hasRgb: true,
  hasIntensity: true,
  hasClassification: true,
  hasGpsTime: true,
  isGeoreferenced: true,
});

const tikalE57 = desc({
  sourceFormat: 'e57',
  hasRgb: true,
  hasIntensity: true,
  hasNormals: false,
  isGeoreferenced: false,
  extentMetres: [50, 54, 47],
  provenance: {
    creator: 'A. Urias',
    organization: 'Aurtech',
    license: 'CC-BY-4.0',
    accuracyClass: 'reference_based_not_survey_grade',
    publicationStatus: 'research_sample',
    limitations: 'Not photogrammetric, not archaeological survey data.',
  },
});

const elEleganteE57 = desc({
  sourceFormat: 'e57',
  hasRgb: true,
  hasIntensity: true,
  isGeoreferenced: false,
  extentMetres: [3500, 3500, 300],
});

const statueGlb = desc({
  sourceFormat: 'glb',
  hasRgb: false,
  hasTexture: true,
  isMesh: true,
  extentMetres: [0.608, 0.389, 0.544],
});

const polycamGlb = desc({
  sourceFormat: 'glb',
  hasTexture: true,
  isMesh: true,
  extentMetres: [0.6, 0.4, 0.5],
  generator: 'Polycam (iOS) 3.4',
});

const bareCadMesh = desc({
  sourceFormat: 'glb',
  hasRgb: false,
  hasTexture: false,
  isMesh: true,
  extentMetres: [0.5, 0.5, 0.5],
});

describe('profileFor', () => {
  it('survey formats stay on the unchanged geo path', () => {
    expect(profileFor(surveyCopc)).toBe('geo');
    expect(profileFor(desc({ sourceFormat: 'las', isGeoreferenced: true }))).toBe('geo');
    expect(profileFor(desc({ sourceFormat: 'ept', isGeoreferenced: true }))).toBe('geo');
  });

  it('a bare (local-frame) E57/PTX/PTS is terrestrial-scan', () => {
    expect(profileFor(tikalE57)).toBe('terrestrial-scan');
    expect(profileFor(elEleganteE57)).toBe('terrestrial-scan');
    expect(profileFor(desc({ sourceFormat: 'ptx' }))).toBe('terrestrial-scan');
    expect(profileFor(desc({ sourceFormat: 'pts' }))).toBe('terrestrial-scan');
  });

  it('a georeferenced E57 keeps the full geo path (its CRS rows are real)', () => {
    expect(profileFor(desc({ sourceFormat: 'e57', isGeoreferenced: true }))).toBe('geo');
  });

  it('an object-scale coloured mesh with no generator is handheld-scan', () => {
    expect(profileFor(statueGlb)).toBe('handheld-scan');
  });

  it('a generator match forces handheld-scan even at building scale', () => {
    expect(profileFor(desc({ ...polycamGlb, extentMetres: [200, 40, 200] }))).toBe('handheld-scan');
  });

  it('an untextured / uncoloured mesh is a plain mesh, not a capture', () => {
    expect(profileFor(bareCadMesh)).toBe('mesh');
  });

  it('a large textured mesh (site scale, no generator) is a plain mesh', () => {
    expect(profileFor(desc({ sourceFormat: 'glb', hasTexture: true, isMesh: true, extentMetres: [200, 50, 200] }))).toBe('mesh');
  });

  it('a mesh with unknown extent and no generator cannot be confirmed a capture', () => {
    expect(profileFor(desc({ sourceFormat: 'glb', hasTexture: true, isMesh: true }))).toBe('mesh');
  });

  it('a plain PLY/OBJ point cloud that is not capture-shaped stays on the geo path', () => {
    expect(profileFor(desc({ sourceFormat: 'ply', isMesh: false, hasRgb: false, extentMetres: [500, 500, 80] }))).toBe('geo');
  });

  it('a small coloured PLY point cloud reads as a handheld capture', () => {
    expect(profileFor(desc({ sourceFormat: 'ply', isMesh: false, hasRgb: true, extentMetres: [1.2, 0.8, 1.0] }))).toBe('handheld-scan');
  });
});

describe('detectHandheld', () => {
  it('matches known generators case-insensitively and names the source', () => {
    expect(detectHandheld(desc({ sourceFormat: 'glb', generator: 'SCANIVERSE 2.1' }))).toMatchObject({
      isHandheld: true,
      confidence: 'high',
      source: 'Scaniverse',
    });
    expect(detectHandheld(desc({ sourceFormat: 'ply', generator: 'exported by 3D Scanner App' })).source).toBe('3D Scanner App');
  });

  it('falls back to a low-confidence geometry signal without a generator', () => {
    const d = detectHandheld(statueGlb);
    expect(d.isHandheld).toBe(true);
    expect(d.confidence).toBe('low');
    expect(d.source).toBeUndefined();
  });

  it('rejects meshes with survey attributes or no colour', () => {
    expect(detectHandheld(bareCadMesh).isHandheld).toBe(false);
    expect(detectHandheld(desc({ sourceFormat: 'glb', hasTexture: true, isMesh: true, hasClassification: true, extentMetres: [1, 1, 1] })).isHandheld).toBe(false);
    expect(detectHandheld(desc({ sourceFormat: 'glb', hasTexture: true, isMesh: true, isGeoreferenced: true, extentMetres: [1, 1, 1] })).isHandheld).toBe(false);
  });

  it('rejects a non-finite or over-scale extent for the geometry signal', () => {
    expect(detectHandheld(desc({ sourceFormat: 'glb', hasTexture: true, isMesh: true, extentMetres: [Number.NaN, 1, 1] })).isHandheld).toBe(false);
    expect(detectHandheld(desc({ sourceFormat: 'glb', hasTexture: true, isMesh: true, extentMetres: [HANDHELD_MAX_EXTENT_M + 1, 1, 1] })).isHandheld).toBe(false);
  });
});

describe('sectionVisible', () => {
  const allSections: SectionId[] = [
    'pointCount', 'density', 'surveyDensityFraming', 'bounds', 'scale',
    'rgbColour', 'intensityColour', 'normalsColour', 'texturedColour',
    'classification', 'crsDatum', 'usgsQualityLevel', 'groundCoverage',
    'dtmContours', 'verticalAccuracy', 'measure', 'clip', 'sectionProfile',
    'perPointReadout', 'provenanceCard',
  ];

  it('geo shows every section (unchanged)', () => {
    for (const s of allSections) expect(sectionVisible('geo', s)).toBe(true);
  });

  it('terrestrial-scan hides CRS/classification/QL/coverage/DTM/vertical/survey-density', () => {
    for (const s of ['classification', 'crsDatum', 'usgsQualityLevel', 'groundCoverage', 'dtmContours', 'verticalAccuracy', 'surveyDensityFraming'] as SectionId[]) {
      expect(sectionVisible('terrestrial-scan', s), s).toBe(false);
    }
    for (const s of ['rgbColour', 'intensityColour', 'normalsColour', 'bounds', 'measure', 'clip', 'sectionProfile', 'perPointReadout', 'provenanceCard'] as SectionId[]) {
      expect(sectionVisible('terrestrial-scan', s), s).toBe(true);
    }
  });

  it('handheld-scan additionally hides intensity and survey density', () => {
    expect(sectionVisible('handheld-scan', 'intensityColour')).toBe(false);
    expect(sectionVisible('handheld-scan', 'density')).toBe(false);
    for (const s of ['rgbColour', 'texturedColour', 'normalsColour', 'scale', 'measure', 'clip', 'perPointReadout'] as SectionId[]) {
      expect(sectionVisible('handheld-scan', s), s).toBe(true);
    }
  });

  it('mesh hides the provenance card and all survey/terrain rows but keeps geometry colour', () => {
    expect(sectionVisible('mesh', 'provenanceCard')).toBe(false);
    expect(sectionVisible('mesh', 'classification')).toBe(false);
    expect(sectionVisible('mesh', 'dtmContours')).toBe(false);
    for (const s of ['rgbColour', 'texturedColour', 'normalsColour', 'bounds', 'measure', 'clip'] as SectionId[]) {
      expect(sectionVisible('mesh', s), s).toBe(true);
    }
  });
});

describe('profileHeadline', () => {
  it('states the terrestrial local frame as a fact, not a defect', () => {
    expect(profileHeadline(tikalE57)).toBe('Terrestrial laser scan — local coordinates');
  });

  it('names the app on a high-confidence handheld, stays neutral otherwise', () => {
    expect(profileHeadline(polycamGlb)).toBe('Handheld LiDAR scan (Polycam) — local coordinates');
    expect(profileHeadline(statueGlb)).toBe('Handheld / object capture — local coordinates');
  });

  it('labels a plain mesh and leaves the geo path headline empty', () => {
    expect(profileHeadline(bareCadMesh)).toBe('Mesh — local coordinates');
    expect(profileHeadline(surveyCopc)).toBe('');
  });
});

describe('isReferenceGradeProvenance', () => {
  it('is true when the block declares a non-survey / reference / research status', () => {
    expect(isReferenceGradeProvenance(tikalE57.provenance)).toBe(true);
    expect(isReferenceGradeProvenance({ accuracyClass: 'reference_based_not_survey_grade' })).toBe(true);
    expect(isReferenceGradeProvenance({ publicationStatus: 'research_sample' })).toBe(true);
  });

  it('is false for absent or survey-grade provenance', () => {
    expect(isReferenceGradeProvenance(undefined)).toBe(false);
    expect(isReferenceGradeProvenance(elEleganteE57.provenance)).toBe(false);
    expect(isReferenceGradeProvenance({ accuracyClass: 'survey_grade', publicationStatus: 'published' })).toBe(false);
  });
});
