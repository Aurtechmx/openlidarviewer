/**
 * layerModel.test.ts — the pure Layers logic: isolate/solo visibility
 * resolution and cross-layer CRS-mismatch detection (the alignment check
 * change-detection depends on). No DOM.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveVisibility,
  nextSolo,
  detectCrsMismatch,
  type LayerInfo,
} from '../src/model/layerModel';

function layer(over: Partial<LayerInfo> = {}): LayerInfo {
  return {
    id: 'a',
    name: 'Scan A',
    pointCount: 100,
    visible: true,
    locked: false,
    ...over,
  };
}

describe('resolveVisibility', () => {
  it('with no solo, each layer keeps its own visible flag', () => {
    const layers = [
      layer({ id: 'a', visible: true }),
      layer({ id: 'b', visible: false }),
    ];
    const v = resolveVisibility(layers, null);
    expect(v.get('a')).toBe(true);
    expect(v.get('b')).toBe(false);
  });

  it('with a solo target, only that layer is visible (others forced off)', () => {
    const layers = [
      layer({ id: 'a', visible: true }),
      layer({ id: 'b', visible: true }),
      layer({ id: 'c', visible: false }),
    ];
    const v = resolveVisibility(layers, 'b');
    expect(v.get('a')).toBe(false);
    expect(v.get('b')).toBe(true);
    expect(v.get('c')).toBe(false);
  });
});

describe('nextSolo', () => {
  it('solos a fresh layer, and clears when the soloed layer is clicked again', () => {
    expect(nextSolo(null, 'a')).toBe('a');
    expect(nextSolo('a', 'b')).toBe('b');
    expect(nextSolo('a', 'a')).toBe(null);
  });
});

describe('detectCrsMismatch', () => {
  it('a single layer never mismatches', () => {
    const r = detectCrsMismatch([layer({ epsg: 32612 })]);
    expect(r.hasMismatch).toBe(false);
    expect(r.summary).toBe('');
  });

  it('two layers with the same EPSG do not mismatch', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 32612 }),
      layer({ id: 'b', epsg: 32612 }),
    ]);
    expect(r.hasMismatch).toBe(false);
    expect(r.mismatched).toEqual([]);
  });

  it('flags a layer with a different EPSG against the majority reference', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 32612, crsName: 'UTM 12N' }),
      layer({ id: 'b', epsg: 32612, crsName: 'UTM 12N' }),
      layer({ id: 'c', epsg: 32613, crsName: 'UTM 13N' }),
    ]);
    expect(r.hasMismatch).toBe(true);
    expect(r.referenceLabel).toBe('UTM 12N');
    expect(r.mismatched.map((m) => m.id)).toEqual(['c']);
    expect(r.mismatched[0].reason).toContain('UTM 13N');
    expect(r.summary).toContain('overlay may be misaligned');
  });

  it('flags a differing vertical datum even when the horizontal CRS matches', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 32612, verticalDatum: 'NAVD88' }),
      layer({ id: 'b', epsg: 32612, verticalDatum: 'EGM2008' }),
    ]);
    expect(r.hasMismatch).toBe(true);
    expect(r.mismatched.map((m) => m.id)).toEqual(['b']);
    expect(r.mismatched[0].reason).toContain('vertical datum');
  });

  /**
   * The overwhelmingly common real mix: one tile declares NAVD88 (orthometric),
   * the other is a plain LAS whose Z is GNSS ellipsoidal height and declares no
   * vertical datum at all. The two are tens of metres apart vertically — geoid
   * separation is about -17 m in northern Utah — yet the old rule only fired
   * when BOTH sides declared a datum, so this pair reported no mismatch, no
   * unknown, and an empty summary. Silence read as "these agree".
   *
   * It is NOT a mismatch: nothing proves the datums differ. It is a third
   * state — unconfirmable — which is the distinction this module already draws
   * for horizontal CRS, and which `compareDtms` already draws for elevation
   * differencing.
   */
  it('cannot confirm heights when only ONE layer declares a vertical datum', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 26912, verticalDatum: 'NAVD88' }),
      layer({ id: 'b', epsg: 26912 }),
    ]);
    expect(r.verticalUnconfirmed).toEqual(['b']);
    // Not a mismatch — an unproven difference must not read as a proven one.
    expect(r.mismatched).toEqual([]);
    expect(r.summary).toMatch(/height/i);
  });

  it('cannot confirm heights when NEITHER layer declares a vertical datum', () => {
    // One could be orthometric and the other ellipsoidal; nothing says otherwise.
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 26912 }),
      layer({ id: 'b', epsg: 26912 }),
    ]);
    expect(r.verticalUnconfirmed).toEqual(['a', 'b']);
    expect(r.summary).toMatch(/height/i);
  });

  it('is silent about heights when both layers agree on a datum', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 26912, verticalDatum: 'NAVD88' }),
      layer({ id: 'b', epsg: 26912, verticalDatum: 'NAVD88' }),
    ]);
    expect(r.verticalUnconfirmed).toEqual([]);
    expect(r.summary).toBe('');
  });

  it('says nothing about heights for a single layer', () => {
    // Nothing to compare against, so there is no claim to qualify.
    const r = detectCrsMismatch([layer({ id: 'a', epsg: 26912 })]);
    expect(r.verticalUnconfirmed).toEqual([]);
    expect(r.summary).toBe('');
  });

  it('reports a proven vertical difference as a mismatch, not as unconfirmed', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 26912, verticalDatum: 'NAVD88' }),
      layer({ id: 'b', epsg: 26912, verticalDatum: 'EGM2008' }),
    ]);
    expect(r.mismatched.map((m) => m.id)).toEqual(['b']);
    expect(r.verticalUnconfirmed).toEqual([]);
  });

  /**
   * The CRS parsers emit the literal string "Unknown CRS" as a DISPLAY name
   * when nothing could be parsed. `horizontalKey` fell back to that name, so
   * the placeholder became a valid identity and two un-georeferenced layers
   * compared EQUAL — reported as sharing a coordinate system, absent from the
   * `unknown` list, and merged into the project frame as aligned.
   *
   * That inverts this module's stated contract: "can't compare" is a distinct
   * state from "matches". A placeholder is the absence of a CRS, not one.
   */
  it('does not treat the "Unknown CRS" placeholder as a shared coordinate system', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', crsName: 'Unknown CRS' }),
      layer({ id: 'b', crsName: 'Unknown CRS' }),
    ]);
    expect(r.unknown).toEqual(['a', 'b']);
    expect(r.mismatched).toEqual([]);
    expect(r.summary).toContain("without a declared CRS");
  });

  it('treats the parser\'s truncated-VLR placeholders as undeclared too', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', crsName: 'Unknown CRS (truncated GeoTIFF VLR)' }),
      layer({ id: 'b', crsName: 'Unknown CRS (truncated GeoTIFF keys)' }),
    ]);
    expect(r.unknown).toEqual(['a', 'b']);
  });

  it('still treats a real CRS name as an identity when no EPSG is declared', () => {
    // Named-but-codeless CRSs are legitimate; only the placeholder is not.
    const r = detectCrsMismatch([
      layer({ id: 'a', crsName: 'NAD83 / Utah Central' }),
      layer({ id: 'b', crsName: 'NAD83 / Utah Central' }),
    ]);
    expect(r.unknown).toEqual([]);
    expect(r.hasMismatch).toBe(false);
  });

  it('lists layers without a declared CRS as unknown, not mismatched', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', epsg: 32612 }),
      layer({ id: 'b', epsg: 32612 }),
      layer({ id: 'c' }), // no epsg, no crsName
    ]);
    expect(r.hasMismatch).toBe(false);
    expect(r.unknown).toEqual(['c']);
  });

  it('notes unknown-CRS layers when fewer than two are comparable', () => {
    const r = detectCrsMismatch([layer({ id: 'a' }), layer({ id: 'b' })]);
    expect(r.hasMismatch).toBe(false);
    expect(r.unknown).toEqual(['a', 'b']);
    expect(r.summary).toContain("can't check alignment");
  });

  it('falls back to the CRS name when no EPSG is present', () => {
    const r = detectCrsMismatch([
      layer({ id: 'a', crsName: 'Local grid A' }),
      layer({ id: 'b', crsName: 'Local grid B' }),
    ]);
    expect(r.hasMismatch).toBe(true);
    expect(r.referenceLabel).toBe('Local grid A');
  });
});
