/**
 * flaiCatalog.test.ts
 *
 * Contract test for the FLAI Open LiDAR Data entries in the curated
 * catalog. Every FLAI-sourced tile must:
 *   - Stream from the documented S3 bucket
 *   - Use the COPC extension (so the streaming pipeline routes it
 *     through HttpRangeSource, not the static-file decode path)
 *   - Carry attribution in the hint string (license accountability)
 *   - Have the native EPSG on its own record registered in CrsRegistry,
 *     so the Inspector override panel reads as a named projection rather
 *     than a bare number
 *
 * The EPSG for each entry is read from the catalog record. This file used
 * to keep its own mapping, which meant the assertion compared two copies
 * of the same claim and passed whenever they agreed, wrong or not.
 *
 * Nothing here reaches the network. Reachability is a dated claim on each
 * record; this file is the static contract on the manifest itself.
 */

import { describe, it, expect } from 'vitest';
import {
  CURATED_LICENSE_IDS,
  CURATED_LOCATIONS,
} from '../src/io/catalog/curatedLocations';
import { getCrsEntry } from '../src/geo/CrsRegistry';

const FLAI_BUCKET_PREFIX =
  'https://open-lidar-data.s3.eu-central-1.amazonaws.com/';

const flaiEntries = CURATED_LOCATIONS.filter((c) => c.id.startsWith('flai-'));

describe('FLAI Open LiDAR Data catalog entries', () => {
  it('ships the curated showcase set', () => {
    // The catalog leads with the two showcase tiles (Switzerland,
    // Slovenia), each on a verified open licence. Netherlands AHN4 was
    // dropped when its open-data status could not be confirmed against an
    // authoritative AHN source. If a future change adds or removes an
    // entry without updating the expected count, this assertion fails
    // loudly.
    expect(flaiEntries).toHaveLength(2);
  });

  it.each(flaiEntries)('$id streams from the documented S3 bucket', (loc) => {
    expect(loc.streamUrl.startsWith(FLAI_BUCKET_PREFIX)).toBe(true);
  });

  it.each(flaiEntries)('$id is a .copc.laz file', (loc) => {
    expect(loc.streamUrl.endsWith('.copc.laz')).toBe(true);
  });

  it.each(flaiEntries)('$id credits FLAI in the hint', (loc) => {
    // License + attribution must be visible to the user before they
    // click. The shared "FLAI Open LiDAR Data" stem is the documented
    // source; each entry also names its government data programme.
    expect(loc.hint).toMatch(/FLAI Open LiDAR Data/);
  });

  it.each(flaiEntries)('$id states its licence as an identity, not prose', (loc) => {
    // The terms live in `licenseId`, drawn from a closed vocabulary, so
    // they can be compared. A hint reading "open data" satisfied the
    // older assertion while naming no licence at all.
    expect(CURATED_LICENSE_IDS as readonly string[]).toContain(loc.licenseId);
    expect(loc.publisher).not.toBe('unknown');
  });

  it.each(flaiEntries)('$id native EPSG is registered in CrsRegistry', (loc) => {
    expect(loc.nativeEpsg, `native EPSG not recorded for ${loc.id}`).not.toBe('unknown');
    if (loc.nativeEpsg === 'unknown') return;
    const entry = getCrsEntry(loc.nativeEpsg);
    expect(entry, `EPSG ${loc.nativeEpsg} not in registry for ${loc.id}`).toBeDefined();
    expect(entry?.region).toBe('europe');
    expect(entry?.kind).toBe('projected');
  });

  it.each(flaiEntries)('$id has a coherent country / bbox pairing', (loc) => {
    // Lightweight sanity — every FLAI entry's bbox falls inside its
    // country's broad geographic envelope. Catches a copy-paste typo
    // that swaps two entries' bboxes.
    const country = loc.id.split('-')[1];
    const [minLon, minLat, maxLon, maxLat] = loc.bbox;
    const envelopes: Readonly<Record<string, [number, number, number, number]>> = {
      lu: [5.7, 49.4, 6.6, 50.2],
      ee: [21.7, 57.5, 28.3, 59.7],
      es: [-9.5, 35.9, 4.4, 43.9],
      be: [2.5, 49.4, 6.5, 51.6],
      fi: [19.3, 59.7, 31.6, 70.1],
      ch: [5.9, 45.8, 10.6, 47.9],
      si: [13.3, 45.4, 16.7, 46.9],
      nl: [3.3, 50.7, 7.3, 53.6],
    };
    const env = envelopes[country];
    expect(env, `Country envelope missing for ${country}`).toBeDefined();
    if (!env) return;
    const [eMinLon, eMinLat, eMaxLon, eMaxLat] = env;
    expect(minLon).toBeGreaterThanOrEqual(eMinLon);
    expect(minLat).toBeGreaterThanOrEqual(eMinLat);
    expect(maxLon).toBeLessThanOrEqual(eMaxLon);
    expect(maxLat).toBeLessThanOrEqual(eMaxLat);
  });
});
