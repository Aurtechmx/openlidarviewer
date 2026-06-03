/**
 * flaiCatalog.test.ts
 *
 * Contract test for the FLAI Open LiDAR Data entries in the curated
 * catalog. Every FLAI-sourced tile must:
 *   - Stream from the documented S3 bucket
 *   - Use the COPC extension (so the streaming pipeline routes it
 *     through HttpRangeSource, not the static-file decode path)
 *   - Carry attribution in the hint string (license accountability)
 *   - Have its native EPSG registered in CrsRegistry so the Inspector
 *     override panel reads as a named projection, not a bare number
 *
 * Network probing lives in `tools/verify-flai-urls.sh` — that script
 * is the live-data verifier and is intended to run before each
 * release. This file is the static contract on the manifest itself.
 */

import { describe, it, expect } from 'vitest';
import { CURATED_LOCATIONS } from '../src/io/catalog/curatedLocations';
import { getCrsEntry } from '../src/geo/CrsRegistry';

const FLAI_BUCKET_PREFIX =
  'https://open-lidar-data.s3.eu-central-1.amazonaws.com/';

const FLAI_EPSG_BY_ID: Readonly<Record<string, number>> = {
  'flai-ch-swisssurface3d-2022': 2056,
  'flai-si-clss-2023': 3794,
  'flai-nl-ahn4': 28992,
};

const flaiEntries = CURATED_LOCATIONS.filter((c) => c.id.startsWith('flai-'));

describe('FLAI Open LiDAR Data catalog entries', () => {
  it('ships the curated showcase set', () => {
    // v0.3.8 re-ordering: the catalog leads with the three
    // highest-impact tiles (Switzerland, Slovenia, Netherlands). The
    // five smaller "download-speed-first" entries were dropped to
    // make room for showcase examples. If a future change adds or
    // removes an entry without updating the expected count, this
    // assertion fails loudly.
    expect(flaiEntries.length).toBe(3);
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

  it.each(flaiEntries)('$id has a hint that names the license', (loc) => {
    // Permissive licences only — CC BY 4.0, CC0, "public domain" or
    // "open data" must appear in the hint so a user knows the terms.
    expect(loc.hint).toMatch(/CC BY 4\.0|CC0|public domain|open data/i);
  });

  it.each(flaiEntries)('$id native EPSG is registered in CrsRegistry', (loc) => {
    const expectedEpsg = FLAI_EPSG_BY_ID[loc.id];
    expect(expectedEpsg, `EPSG mapping missing for ${loc.id}`).toBeDefined();
    const entry = getCrsEntry(expectedEpsg);
    expect(entry, `EPSG ${expectedEpsg} not in registry for ${loc.id}`).toBeDefined();
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
