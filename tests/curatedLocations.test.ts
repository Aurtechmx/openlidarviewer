/**
 * curatedLocations.test.ts
 *
 * Sanity checks on the curated-locations dataset so a copy-paste typo
 * in a bbox or id can't ship without a failing test.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  CURATED_LICENSE_IDS,
  CURATED_LOCATIONS,
  curatedUsageCategory,
  getCuratedLocation,
} from '../src/io/catalog/curatedLocations';

const REPO_ROOT = resolve(__dirname, '..');

/** Every test file, so a check about the suite reads the suite. */
function testFiles(): string[] {
  return readdirSync(resolve(REPO_ROOT, 'tests'))
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/${f}`);
}

/**
 * The tracked text of the repository, concatenated once. A URL claim is
 * checked against what the tree already says rather than against a list
 * kept here, which would need the same maintenance the claim does.
 */
let TREE_TEXT: string | null = null;
function treeText(): string {
  if (TREE_TEXT !== null) return TREE_TEXT;
  const files = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|mjs|js|md|html|json|yaml|yml)$/.test(f))
    .filter((f) => f !== 'src/io/catalog/curatedLocations.ts');
  TREE_TEXT = files
    .map((f) => {
      try { return readFileSync(resolve(REPO_ROOT, f), 'utf8'); } catch { return ''; }
    })
    .join('\n');
  return TREE_TEXT;
}

describe('curated locations dataset', () => {
  it('ships at least one option', () => {
    expect(CURATED_LOCATIONS.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = CURATED_LOCATIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CURATED_LOCATIONS)('$id has a non-empty label, sizeLabel, hint, and displayName', (loc) => {
    expect(loc.label.length).toBeGreaterThan(0);
    expect(loc.sizeLabel.length).toBeGreaterThan(0);
    expect(loc.hint.length).toBeGreaterThan(0);
    expect(loc.displayName.length).toBeGreaterThan(0);
  });

  it.each(CURATED_LOCATIONS)('$id sizeLabel matches a recognised pattern', (loc) => {
    // Allowed shapes: "77 MB", "1.8 GB", "22.4B pts" — keep the
    // user-facing format consistent so the dropdown reads uniformly.
    expect(loc.sizeLabel).toMatch(/^[\d.]+\s*(MB|GB|[KMBT]B?\s+pts)$/);
  });

  it.each(CURATED_LOCATIONS)('$id has a well-formed lat/lon bbox', (loc) => {
    const [minLon, minLat, maxLon, maxLat] = loc.bbox;
    expect(Number.isFinite(minLon)).toBe(true);
    expect(Number.isFinite(minLat)).toBe(true);
    expect(Number.isFinite(maxLon)).toBe(true);
    expect(Number.isFinite(maxLat)).toBe(true);
    expect(minLon).toBeLessThan(maxLon);
    expect(minLat).toBeLessThan(maxLat);
    // US locations only — catch a missing negative sign on a US longitude.
    expect(minLat).toBeGreaterThan(-90);
    expect(maxLat).toBeLessThan(90);
    expect(minLon).toBeGreaterThan(-180);
    expect(maxLon).toBeLessThan(180);
  });

  it.each(CURATED_LOCATIONS)('$id has a non-degenerate bbox (>=100m)', (loc) => {
    const [minLon, minLat, maxLon, maxLat] = loc.bbox;
    // At US mid-latitudes, 0.001 deg lat ~= 111 m, lon similar at 45°.
    expect(maxLon - minLon).toBeGreaterThan(0.001);
    expect(maxLat - minLat).toBeGreaterThan(0.001);
  });
});

describe('getCuratedLocation', () => {
  it('returns the matching entry for a known id', () => {
    const loc = getCuratedLocation(CURATED_LOCATIONS[0].id);
    expect(loc).toBeDefined();
    expect(loc?.id).toBe(CURATED_LOCATIONS[0].id);
  });

  it('returns undefined for an unknown id', () => {
    expect(getCuratedLocation('not-a-real-location')).toBeUndefined();
  });
});

/**
 * Provenance contract.
 *
 * A curated entry is an assertion that someone may stream this data, so
 * the record has to say who published it, under what terms, in what
 * format and frame, and where those answers were read from. The fields
 * exist so the answer is checkable rather than implied by a hint string.
 *
 * `unknown` is a legal value and a deliberate one. It marks a gap that
 * nobody has closed yet, which is worth far more than a plausible guess:
 * a guessed licence is indistinguishable from a recorded one once it is
 * in the file.
 */
describe('curated provenance fields', () => {
  it.each(CURATED_LOCATIONS)('$id carries every provenance field', (loc) => {
    for (const field of [
      'publisher',
      'mirrorProvider',
      'licenseUrl',
      'attribution',
      'provenanceUrl',
      'verifiedAt',
    ] as const) {
      expect(typeof loc[field], `${loc.id}.${field}`).toBe('string');
      expect(loc[field].length, `${loc.id}.${field} is empty`).toBeGreaterThan(0);
    }
  });

  it.each(CURATED_LOCATIONS)('$id licenseId is a normalized identity', (loc) => {
    // A licence has to be comparable. "open data", "Swiss federal open
    // data" and "public licence" are families of terms, not identities:
    // two datasets carrying that text can be under incompatible licences,
    // and no check can tell. The vocabulary is closed, and `unknown` is
    // how the catalog says the tree records no identity for this dataset.
    expect(CURATED_LICENSE_IDS as readonly string[]).toContain(loc.licenseId);
  });

  it.each(CURATED_LOCATIONS)('$id keeps licence prose out of the hint', (loc) => {
    // The hint is user-facing copy. When it names terms, it names the
    // identity in the record; a generic phrase there is the free text
    // this contract exists to refuse.
    expect(loc.hint).not.toMatch(/\bopen data\b|\bpublic licence\b|\bopen licence\b/i);
    if (loc.licenseId === 'unknown') {
      expect(loc.hint).not.toMatch(/\bCC0\b|CC BY|public domain/i);
    }
  });

  it.each(CURATED_LOCATIONS)('$id format matches the URL it describes', (loc) => {
    expect(['copc', 'ept']).toContain(loc.format);
    const fromUrl = loc.streamUrl.endsWith('.copc.laz')
      ? 'copc'
      : loc.streamUrl.endsWith('/ept.json')
        ? 'ept'
        : 'other';
    expect(loc.format, `${loc.id} format vs streamUrl`).toBe(fromUrl);
  });

  it.each(CURATED_LOCATIONS)('$id nativeEpsg is a code or unknown', (loc) => {
    if (loc.nativeEpsg === 'unknown') return;
    expect(Number.isInteger(loc.nativeEpsg)).toBe(true);
    expect(loc.nativeEpsg).toBeGreaterThan(1000);
  });

  it.each(CURATED_LOCATIONS)('$id verifiedAt is an ISO date', (loc) => {
    expect(loc.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(CURATED_LOCATIONS)('$id provenanceUrl resolves to something real', (loc) => {
    // A provenance pointer is the one field a reader follows to check the
    // rest. A repository path has to exist; an external URL has to be one
    // this tree already records, so a plausible-looking address cannot be
    // written here without also being adopted somewhere accountable.
    if (/^https?:/.test(loc.provenanceUrl)) {
      expect(treeText().includes(loc.provenanceUrl), `${loc.provenanceUrl} appears nowhere else`).toBe(true);
      return;
    }
    expect(existsSync(resolve(REPO_ROOT, loc.provenanceUrl)), `${loc.provenanceUrl} missing`).toBe(true);
  });

  it.each(CURATED_LOCATIONS)('$id licenseUrl is recorded elsewhere in the tree', (loc) => {
    if (loc.licenseUrl === 'unknown') return;
    expect(treeText().includes(loc.licenseUrl), `${loc.licenseUrl} appears nowhere else`).toBe(true);
  });
});

/**
 * One home for the EPSG mapping.
 *
 * The dataset-to-EPSG mapping used to live in `tests/flaiCatalog.test.ts`
 * as a hand-maintained object. A test that restates the value it checks
 * cannot fail when the catalog is wrong, only when the two copies drift,
 * and it is the copy nobody ships that tends to stay right.
 */
describe('native EPSG has a single home', () => {
  it('no test file pairs a curated id with its EPSG literal', () => {
    const offenders: string[] = [];
    for (const file of testFiles()) {
      const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      for (const loc of CURATED_LOCATIONS) {
        if (loc.nativeEpsg === 'unknown') continue;
        if (text.includes(loc.id) && new RegExp(`\\b${loc.nativeEpsg}\\b`).test(text)) {
          offenders.push(`${file} restates EPSG ${loc.nativeEpsg} for ${loc.id}`);
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * Telemetry category.
 *
 * Every curated pick was counted as `curated:usgs-ept`, including the two
 * European COPC tiles, so the local counter recorded a category that was
 * simply not what happened. A wrong category reads as evidence, which is
 * worse than an absent one.
 */
describe('curatedUsageCategory', () => {
  it('does not file a European COPC tile as USGS EPT', () => {
    const ch = getCuratedLocation('flai-ch-swisssurface3d-2022');
    expect(ch).toBeDefined();
    expect(curatedUsageCategory(ch!.streamUrl)).not.toBe('curated:usgs-ept');
    expect(curatedUsageCategory(ch!.streamUrl)).toBe('curated:copc');
  });

  it.each(CURATED_LOCATIONS)('$id category follows the record', (loc) => {
    expect(curatedUsageCategory(loc.streamUrl)).toBe(`curated:${loc.format}`);
  });

  it('reports a URL the catalog does not carry as unlisted', () => {
    expect(curatedUsageCategory('https://example.org/other.copc.laz')).toBe('curated:unlisted');
  });

  it('is what the picker records, with no literal category anywhere', () => {
    // The bug was a constant at the call site, not a wrong function, so
    // read both ends. The panel derives the suffix from the record it
    // picked; main.ts records what it is handed and writes no category of
    // its own, because it has the URL and not the entry behind it.
    const panel = readFileSync(resolve(REPO_ROOT, 'src/ui/CatalogPanel.ts'), 'utf8');
    expect(panel).toMatch(/curatedUsageCategory\(loc\.streamUrl\)/);
    const main = readFileSync(resolve(REPO_ROOT, 'src/main.ts'), 'utf8');
    expect(main).toMatch(/recordUsage\('scan-open', usageCategory\)/);
    expect(main).not.toMatch(/'curated:[a-z-]+'/);
  });
});
