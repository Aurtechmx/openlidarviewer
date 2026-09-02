/**
 * e5ManifestMetadata.test.ts — provenance-correctness of the E5 input manifests.
 *
 * Two metadata errors are pinned closed here. First, the geoid identifier must
 * survive in full: a WKT that says GEOID12B must not be recorded as GEOID12 — the
 * revision letter changes which model was applied. Second, the LAS header
 * creation date is not the acquisition date; the manifest names it as creation
 * and records acquisition from the authoritative USGS WESM provider metadata (the
 * 2019 Rogue flight), never presenting the 2021 file-write as the flight year.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = (name: string) =>
  JSON.parse(readFileSync(resolve(ROOT, `validation/e5/manifests/${name}.input.json`), 'utf8'));

/** The geoid token extraction, isolated so its round-trip is testable. */
function parseGeoid(wkt: string): string | null {
  const m = wkt.match(/Geoid\d{2}[A-Za-z]?/);
  return m ? m[0].toUpperCase() : null;
}

describe('E5 manifest metadata correctness', () => {
  it('GEOID12B round-trips in full — the revision letter is never dropped', () => {
    expect(parseGeoid('VERT_CS["NAVD88 height (Geoid12B)",...]')).toBe('GEOID12B');
    expect(parseGeoid('...Geoid18...')).toBe('GEOID18');
    expect(parseGeoid('...Geoid12...')).toBe('GEOID12'); // no letter → no invented one
  });

  for (const [name, expectedGeoid, expectedFrame, expectedAcqYear] of [
    ['ROGUE25', 'GEOID12B', 6339, 2019],
    ['HOUSTON17', 'GEOID18', 6344, null],
  ] as const) {
    const m = load(name);

    it(`${name} records the complete geoid (${expectedGeoid}) per tile and in the summary`, () => {
      expect(m.summary.geoidModel).toEqual([expectedGeoid]);
      for (const t of m.tiles) expect(t.geoidModel).toBe(expectedGeoid);
    });

    it(`${name} names LAS creation date as creation, and acquisition from WESM`, () => {
      expect(m.summary).not.toHaveProperty('captureYears');
      for (const t of m.tiles) {
        expect(t).not.toHaveProperty('captureYear');
        expect(t).toHaveProperty('fileCreationYear');
        // Acquisition is sourced authoritatively from USGS WESM (the provider
        // work-unit metadata), never the LAS creation field: Rogue's 2019 flight;
        // Houston's window crosses a calendar year, so its single year stays null.
        expect(t.acquisitionYear).toBe(expectedAcqYear);
        expect(t.acquisitionDateSource).toBe('usgs-wesm');
        // The file-write year is never presented as the acquisition year.
        if (t.acquisitionYear !== null) expect(t.acquisitionYear).not.toBe(t.fileCreationYear);
      }
    });

    it(`${name} frame is homogeneous at the expected EPSG`, () => {
      expect(m.summary.horizontalEpsg).toEqual([expectedFrame]);
      expect(m.summary.verticalEpsg).toEqual([5703]);
      expect(m.summary.homogeneousFrame).toBe(true);
    });

    it(`${name} collection digest still matches the source bytes (metadata fix changed no LAZ)`, () => {
      const recomputed = createHash('sha256')
        .update([...m.tiles].sort((a: {basename:string}, b: {basename:string}) => a.basename.localeCompare(b.basename))
          .map((t: {basename:string;sha256:string}) => `${t.basename}:${t.sha256}`).join('\n'))
        .digest('hex');
      expect(recomputed).toBe(m.collectionDigest);
    });
  }
});
