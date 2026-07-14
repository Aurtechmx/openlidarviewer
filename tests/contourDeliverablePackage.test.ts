/**
 * contourDeliverablePackage.test.ts
 *
 * The ZIP-assembly wiring for the complete contour deliverable: given the PR11
 * manifest (which decides which files are included/omitted) + produced bytes,
 * assemble the real ZIP and prove:
 *  - every INCLUDED product is written with exactly the supplied bytes;
 *  - OMITTED products are absent (no empty placeholders);
 *  - the README from the manifest is written verbatim;
 *  - SHA256SUMS covers every file, never itself, and each digest re-verifies
 *    (a real `shasum -c` pass);
 *  - an included product with no bytes throws (never ships a promised-but-empty
 *    file).
 */

import { describe, it, expect } from 'vitest';
import {
  assembleContourDeliverable,
  type PackageByteMap,
} from '../src/terrain/export/contourDeliverablePackage';
import {
  buildContourPackageManifest,
  type PackageInput,
  type PackageRole,
} from '../src/terrain/contourStudio/contourPackageManifest';
import { sha256Hex } from '../src/terrain/export/sha256';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Minimal reader for a store-only (no-compression) ZIP: walk local headers. */
function readStoreZip(zip: Uint8Array): Map<string, Uint8Array> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, Uint8Array>();
  let p = 0;
  while (p + 4 <= zip.length && dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 22, true); // uncompressed == compressed (store)
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const nameStart = p + 30;
    const name = new TextDecoder().decode(zip.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    out.set(name, zip.subarray(dataStart, dataStart + size));
    p = dataStart + size;
  }
  return out;
}

function input(over: Partial<PackageInput> = {}): PackageInput {
  return {
    projectName: 'Site A',
    decision: { status: 'validated', badge: 'Internal validation', caveats: [] },
    available: {
      pdf: false,
      analyticalGeojson: true,
      cartographicGeojson: false,
      cartographicDxf: true,
      dtm: true,
      hillshade: false,
      support: false,
      uncertainty: false,
      validationJson: false,
      provenanceJson: true,
      studioJson: false,
    },
    provenance: {
      crs: 'EPSG:32610',
      verticalDatum: 'unknown',
      horizontalUnit: 'm',
      verticalUnit: 'm',
      software: 'OpenLiDARViewer',
      softwareVersion: '0.5.9',
    },
    citation: 'OpenLiDARViewer, Site A contour deliverable, 2026.',
    ...over,
  };
}

/** Fake bytes for exactly the product roles the manifest marks included. */
function bytesFor(manifest: ReturnType<typeof buildContourPackageManifest>): PackageByteMap {
  const m = new Map<PackageRole, Uint8Array>();
  for (const e of manifest.entries) {
    if (e.status !== 'included') continue;
    if (e.role === 'readme' || e.role === 'checksums') continue;
    m.set(e.role, enc(`bytes-for:${e.role}`));
  }
  return m;
}

describe('assembleContourDeliverable', () => {
  it('writes every included product with the supplied bytes and omits the rest', () => {
    const manifest = buildContourPackageManifest(input());
    const zip = readStoreZip(assembleContourDeliverable(manifest, bytesFor(manifest)));

    // Included products present with exact bytes.
    for (const e of manifest.entries) {
      if (e.status === 'included' && e.role !== 'readme' && e.role !== 'checksums') {
        expect(zip.has(e.filename), `missing included ${e.filename}`).toBe(true);
        expect(new TextDecoder().decode(zip.get(e.filename)!)).toBe(`bytes-for:${e.role}`);
      }
      // Omitted products absent — no empty placeholder.
      if (e.status === 'omitted') {
        expect(zip.has(e.filename), `omitted file leaked: ${e.filename}`).toBe(false);
      }
    }
  });

  it('writes the manifest README verbatim', () => {
    const manifest = buildContourPackageManifest(input());
    const zip = readStoreZip(assembleContourDeliverable(manifest, bytesFor(manifest)));
    const readme = manifest.entries.find((e) => e.role === 'readme')!;
    expect(new TextDecoder().decode(zip.get(readme.filename)!)).toBe(manifest.readme);
  });

  it('emits a SHA256SUMS that covers every file, never itself, and re-verifies', () => {
    const manifest = buildContourPackageManifest(input());
    const zip = readStoreZip(assembleContourDeliverable(manifest, bytesFor(manifest)));
    const sums = zip.get('SHA256SUMS');
    expect(sums).toBeDefined();
    const lines = new TextDecoder().decode(sums!).trimEnd().split('\n');
    const listed = new Set<string>();
    for (const line of lines) {
      const [hex, name] = line.split('  ');
      expect(name).not.toBe('SHA256SUMS'); // never lists itself
      expect(zip.has(name), `SHA256SUMS lists missing ${name}`).toBe(true);
      expect(sha256Hex(zip.get(name)!), `digest mismatch for ${name}`).toBe(hex);
      listed.add(name);
    }
    // Covers exactly every non-checksum file in the archive.
    for (const name of zip.keys()) {
      if (name !== 'SHA256SUMS') expect(listed.has(name), `${name} not in SHA256SUMS`).toBe(true);
    }
  });

  it('throws when an included product has no bytes (never ships an empty promise)', () => {
    const manifest = buildContourPackageManifest(input());
    const partial = bytesFor(manifest);
    const missing = new Map(partial);
    missing.delete('dtm-raster'); // included, but withhold its bytes
    expect(() => assembleContourDeliverable(manifest, missing)).toThrow(/no bytes supplied for included role/i);
  });

  it('carries the exploratory README into the package for a downgraded decision', () => {
    const manifest = buildContourPackageManifest(input({
      decision: { status: 'exploratory', badge: 'Exploratory', watermark: 'EXPLORATORY', caveats: [] },
    }));
    const zip = readStoreZip(assembleContourDeliverable(manifest, bytesFor(manifest)));
    const readme = manifest.entries.find((e) => e.role === 'readme')!;
    expect(new TextDecoder().decode(zip.get(readme.filename)!)).toMatch(/EXPLORATORY DELIVERABLE/);
  });
});
