/**
 * The format-specification frame (local metres for a glTF or E57 with no CRS)
 * is not a georeference and not a file declaration.
 *
 * It counted as georeferenced, so a bare E57 took the geo profile (its
 * local-coordinates headline vanished) and a coloured 5 m GLB was classed as
 * a mesh. The three local profiles hid the Coordinate system section, so the
 * CRS picker and its local-unit choice could not be reached. A session check
 * read the specification's metres as a unit the file declared, so a user's
 * feet or EPSG:2229 session on a GLB was refused. The verdict said the unit
 * was declared, the batch converter recorded a file CRS origin, and a GLB
 * with the CESIUM_RTC extension (Earth-centred positions) got the frame.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCapabilityDescriptor, provenanceCardModel } from '../src/render/scanCapability';
import { profileFor } from '../src/render/displayProfile';
import { applyDisplayProfile } from '../src/render/applyDisplayProfile';
import { formatSpecificationCrs, resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { validateCrsForMeasurement } from '../src/geo/CrsValidation';
import { declaredCrsOrigin } from '../src/science/crsOrigin';
import { declaredSpatialFromStatic } from '../src/app/sessionScanFacts';
import { loadGltf } from '../src/io/loadGltf';
import { PointCloud } from '../src/model/PointCloud';
import { Inspector } from '../src/ui/Inspector';
import { installInspectorFakeDom, fakeCallbacks } from './helpers/inspectorLazyHarness';

describe('the specification frame is not a georeference for the display profile', () => {
  it('a coloured 5 m GLB is a handheld scan, as with no CRS', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'glb', hasRgb: true, hasIntensity: false, hasClassification: false, hasNormals: false, hasGpsTime: false,
      isMesh: true, extentMetres: [5, 5, 3], crs: formatSpecificationCrs('glTF'),
    });
    expect(d.isGeoreferenced).toBe(false);
    expect(profileFor(d)).toBe('handheld-scan');
    expect(provenanceCardModel(d)?.headline).toBe('Handheld / object capture — local coordinates');
  });

  it('a bare E57 is a terrestrial scan, as with no CRS', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'e57', hasRgb: true, hasIntensity: true, hasClassification: false, hasNormals: false, hasGpsTime: false,
      isMesh: false, extentMetres: [50, 50, 10], crs: formatSpecificationCrs('E57'),
    });
    expect(d.isGeoreferenced).toBe(false);
    expect(profileFor(d)).toBe('terrestrial-scan');
    expect(provenanceCardModel(d)?.headline).toBe('Terrestrial laser scan — local coordinates');
  });

  it('a file CRS still counts', () => {
    const d = buildCapabilityDescriptor({
      sourceFormat: 'las', hasRgb: false, hasIntensity: true, hasClassification: true, hasNormals: false, hasGpsTime: true,
      crs: { name: 'EPSG:6339' },
    });
    expect(d.isGeoreferenced).toBe(true);
  });
});

describe('the Coordinate system section stays reachable on local profiles', () => {
  beforeAll(() => installInspectorFakeDom());

  const cloud = (format: 'glb' | 'e57' | 'obj') => new PointCloud({
    positions: Float32Array.from([0, 0, 0, 5, 3, 5]),
    origin: [0, 0, 0],
    colors: Uint8Array.from([10, 20, 30, 40, 50, 60]),
    sourceFormat: format,
    name: `scan.${format}`,
    ...(format === 'obj' ? {} : { metadata: { crs: formatSpecificationCrs(format === 'glb' ? 'glTF' : 'E57') } }),
  });

  it.each(['glb', 'e57', 'obj'] as const)('%s: present, collapsed, and opened by focusCrsOverride', (format) => {
    const ins = new Inspector(fakeCallbacks());
    const section = (ins as unknown as { _crsSection: { classList: { contains(c: string): boolean }; open: boolean } })._crsSection;
    section.open = true;
    applyDisplayProfile(cloud(format), ins);
    expect(section.classList.contains('olv-hidden')).toBe(false);
    expect(section.open).toBe(false);
    expect(ins.focusCrsOverride()).toBe(true);
    expect(section.open).toBe(true);
  });
});

describe('a session check reads no unit from the specification frame', () => {
  it('the declared facts of a GLB name no unit, kind or code', () => {
    const facts = declaredSpatialFromStatic({
      name: 'scan.glb', pointCount: 2, sourceFormat: 'glb', bounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
      metadata: { crs: formatSpecificationCrs('glTF') },
    } as never);
    expect(facts.linearUnit).toBeUndefined();
    expect(facts.linearUnitToMetres).toBeUndefined();
    expect(facts.kind).toBeUndefined();
    expect(facts.epsg).toBeUndefined();
  });
});

describe('smaller points', () => {
  it('the verdict names the specification', () => {
    const v = validateCrsForMeasurement(resolvedFromCrsInfo(formatSpecificationCrs('glTF'), 'las-vlr'));
    expect(v.reason).toBe('Local coordinates in metres, as the glTF specification defines them.');
    expect(validateCrsForMeasurement(resolvedFromCrsInfo(formatSpecificationCrs('E57'), 'las-vlr')).reason)
      .toBe('Local coordinates in metres, as the E57 specification defines them.');
  });

  it('the batch converter records no file CRS origin for it', () => {
    expect(declaredCrsOrigin(formatSpecificationCrs('glTF'))).toBeNull();
  });

  it('a GLB with the CESIUM_RTC extension gets no specification frame', async () => {
    const file = readFileSync(fileURLToPath(new URL('./fixtures/tiny.glb', import.meta.url)));
    const bytes = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLen = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen)));
    json.extensionsUsed = [...(json.extensionsUsed ?? []), 'CESIUM_RTC'];
    json.extensions = { ...(json.extensions ?? {}), CESIUM_RTC: { center: [-1500000, -4800000, 3800000] } };
    let text = JSON.stringify(json);
    while (text.length % 4 !== 0) text += ' ';
    const jsonBytes = new TextEncoder().encode(text);
    const rest = bytes.subarray(20 + jsonLen);
    const out = new Uint8Array(20 + jsonBytes.length + rest.length);
    out.set(bytes.subarray(0, 12), 0);
    const odv = new DataView(out.buffer);
    odv.setUint32(8, out.length, true);
    odv.setUint32(12, jsonBytes.length, true);
    odv.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    out.set(rest, 20 + jsonBytes.length);
    const cloud = await loadGltf(out.buffer, 'glb', 'rtc.glb');
    expect(cloud.metadata?.crs).toBeUndefined();
    const plain = await loadGltf(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), 'glb', 'tiny.glb');
    expect(plain.metadata?.crs?.formatSpecification).toBe('glTF');
  });
});
void vi;
