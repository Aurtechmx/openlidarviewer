/**
 * e5ManifestVerify.test.ts — the E5 input-manifest gate catches every way an
 * immutable manifest can drift, and the two committed manifests pass.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  verifyManifest,
  collectionDigestOf,
  tileIdOf,
  loadWesmLedger,
  // @ts-expect-error — plain .mjs verifier, no type declarations.
} from '../scripts/e5/verify-input-manifest.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MDIR = resolve(ROOT, 'validation/e5/manifests');
const WESM = loadWesmLedger(resolve(MDIR, 'wesm-acquisition.json')) as Map<string, Record<string, unknown>>;

/** A minimal but internally consistent two-tile manifest. */
function goodManifest() {
  const tiles = [
    {
      basename: 'USGS_LPC_OR_Rogue_2019_B19_10TDM3449.laz',
      sha256: 'a'.repeat(64),
      bytes: 100,
      pointCount: 10,
      horizontalEpsg: 6339,
      verticalEpsg: 5703,
      verticalDatum: 'North American Vertical Datum 1988',
      geoidModel: 'GEOID12B',
      classHistogram: { 1: 5, 2: 5 },
      groundPointCount: 5,
      fileCreationYear: 2021,
      acquisitionYear: null,
      acquisitionDateSource: 'not-established',
    },
    {
      basename: 'USGS_LPC_OR_Rogue_2019_B19_10TDM3746.laz',
      sha256: 'b'.repeat(64),
      bytes: 200,
      pointCount: 20,
      horizontalEpsg: 6339,
      verticalEpsg: 5703,
      verticalDatum: 'North American Vertical Datum 1988',
      geoidModel: 'GEOID12B',
      classHistogram: { 1: 12, 2: 8 },
      groundPointCount: 8,
      fileCreationYear: 2021,
      acquisitionYear: null,
      acquisitionDateSource: 'not-established',
    },
  ];
  return {
    collectionId: 'TEST',
    collectionDigest: collectionDigestOf(tiles),
    summary: {
      tileCount: 2,
      horizontalEpsg: [6339],
      verticalEpsg: [5703],
      verticalDatum: ['North American Vertical Datum 1988'],
      geoidModel: ['GEOID12B'],
      homogeneousFrame: true,
      tilesWithoutGround: [] as string[],
      allTilesHaveGround: true,
      fileCreationYears: [2021],
      acquisitionYears: [null] as (number | null)[],
    },
    tiles,
  };
}

describe('E5 manifest verifier', () => {
  it('derives tileId from the last basename token', () => {
    expect(tileIdOf('USGS_LPC_OR_Rogue_2019_B19_10TDM3449.laz')).toBe('10TDM3449');
    expect(tileIdOf('USGS_LPC_TX_Houston_B24_15RTM260193.laz')).toBe('15RTM260193');
  });

  it('passes a good manifest', () => {
    const r = verifyManifest(goodManifest(), { expectedCount: 2 });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('catches a wrong tile count', () => {
    const r = verifyManifest(goodManifest(), { expectedCount: 3 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/tile count/);
  });

  it('catches a duplicate basename', () => {
    const m = goodManifest();
    m.tiles[1].basename = m.tiles[0].basename;
    m.collectionDigest = collectionDigestOf(m.tiles);
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/duplicate basename/);
  });

  it('catches a duplicate tileId across distinct basenames', () => {
    const m = goodManifest();
    // Same trailing token, different prefix → distinct basename, same tileId.
    m.tiles[1].basename = 'USGS_LPC_OR_Other_2019_B19_10TDM3449.laz';
    m.collectionDigest = collectionDigestOf(m.tiles);
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/duplicate tileId/);
  });

  it('catches a collectionDigest mismatch', () => {
    const m = goodManifest();
    m.collectionDigest = 'f'.repeat(64);
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/collectionDigest mismatch/);
  });

  it('catches a captureYear leftover', () => {
    const m = goodManifest();
    (m.tiles[0] as Record<string, unknown>).captureYear = 2019;
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/captureYear/);
  });

  it('catches a broken homogeneity claim', () => {
    const m = goodManifest();
    m.tiles[1].horizontalEpsg = 6344; // now two frames, but claim stays true
    m.collectionDigest = collectionDigestOf(m.tiles);
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/homogeneousFrame/);
  });

  it('catches a null EPSG', () => {
    const m = goodManifest();
    (m.tiles[0] as Record<string, unknown>).verticalEpsg = null;
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/verticalEpsg is null/);
  });

  it('catches a summary acquisitionYear that relabels a creation year', () => {
    const m = goodManifest();
    m.summary.acquisitionYears = [2021];
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/relabels creation year/);
  });

  it('catches a classHistogram whose values do not sum to pointCount', () => {
    const m = goodManifest();
    m.tiles[0].classHistogram = { 1: 4, 2: 5 }; // sum 9 ≠ pointCount 10
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/classHistogram sum 9 ≠ pointCount 10/);
  });

  it('catches a classHistogram that is not a plain object', () => {
    const m = goodManifest();
    (m.tiles[0] as Record<string, unknown>).classHistogram = [5, 5];
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/classHistogram must be a plain object/);
  });

  it('catches a classHistogram with a negative count', () => {
    const m = goodManifest();
    m.tiles[0].classHistogram = { 1: 15, 2: -5 };
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/classHistogram values must be non-negative integers/);
  });

  it('catches groundPointCount disagreeing with classHistogram[2]', () => {
    const m = goodManifest();
    m.tiles[0].groundPointCount = 4; // histogram class 2 is 5
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/groundPointCount 4 ≠ classHistogram\['2'\] 5/);
  });

  it('catches a groundPointFraction that does not match the ratio', () => {
    const m = goodManifest();
    (m.tiles[0] as Record<string, unknown>).groundPointFraction = 0.4; // true ratio 5/10 = 0.5
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/groundPointFraction 0.4 ≠ recomputed 0.5/);
  });

  it('accepts a matching groundPointFraction', () => {
    const m = goodManifest();
    (m.tiles[0] as Record<string, unknown>).groundPointFraction = 0.5; // 5/10
    (m.tiles[1] as Record<string, unknown>).groundPointFraction = 0.4; // 8/20
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('guards a zero-point tile without dividing by zero', () => {
    const m = goodManifest();
    m.tiles[0].pointCount = 0;
    (m.tiles[0] as Record<string, unknown>).classHistogram = {};
    m.tiles[0].groundPointCount = 0;
    (m.tiles[0] as Record<string, unknown>).groundPointFraction = 0;
    m.summary.tilesWithoutGround = [m.tiles[0].basename];
    m.summary.allTilesHaveGround = false;
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('catches a tilesWithoutGround set that names a tile that has ground', () => {
    const m = goodManifest();
    m.summary.tilesWithoutGround = ['USGS_LPC_OR_Rogue_2019_B19_10TDM3746.laz'];
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/tilesWithoutGround set mismatch/);
  });

  it('catches a tilesWithoutGround set that omits a groundless tile', () => {
    const m = goodManifest();
    m.tiles[1].groundPointCount = 0;
    (m.tiles[1] as Record<string, unknown>).classHistogram = { 1: 20 };
    m.summary.tilesWithoutGround = []; // omits the now-groundless tile
    m.summary.allTilesHaveGround = false;
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/tilesWithoutGround set mismatch/);
  });

  it('catches allTilesHaveGround that disagrees with the members', () => {
    const m = goodManifest();
    m.summary.allTilesHaveGround = false; // every tile actually has ground
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/allTilesHaveGround=false but 0 tile/);
  });

  it('catches a non-null acquisitionYear left as not-established', () => {
    const m = goodManifest();
    (m.tiles[0] as Record<string, unknown>).acquisitionYear = 2019; // year but placeholder source
    m.summary.acquisitionYears = [2019];
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/needs an authoritative acquisitionDateSource/);
  });

  it('accepts a non-null acquisitionYear with an authoritative source', () => {
    const m = goodManifest();
    for (const t of m.tiles) {
      (t as Record<string, unknown>).acquisitionYear = 2019; // window year, distinct from creation 2021
      t.acquisitionDateSource = 'usgs-wesm';
    }
    m.summary.acquisitionYears = [2019];
    const r = verifyManifest(m, { expectedCount: 2 });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('cross-checks a matching WESM frame', () => {
    const m = goodManifest();
    const wesm = {
      horizontalEpsg: 6339,
      verticalEpsg: 5703,
      geoidModel: 'GEOID12B',
      acquisitionYear: null,
    };
    const r = verifyManifest(m, { expectedCount: 2, wesm });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('catches a WESM geoid mismatch (guards Houston units 1-3 vs unit 4)', () => {
    const m = goodManifest();
    const wesm = {
      horizontalEpsg: 6339,
      verticalEpsg: 5703,
      geoidModel: 'GEOID18', // ledger disagrees with the members' GEOID12B
      acquisitionYear: null,
    };
    const r = verifyManifest(m, { expectedCount: 2, wesm });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/WESM geoidModel mismatch/);
  });

  it('catches an acquisitionYear that disagrees with the WESM ledger', () => {
    const m = goodManifest();
    const wesm = {
      horizontalEpsg: 6339,
      verticalEpsg: 5703,
      geoidModel: 'GEOID12B',
      acquisitionYear: 2019, // ledger says 2019, tiles say null
    };
    const r = verifyManifest(m, { expectedCount: 2, wesm });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/acquisitionYear .* ≠ WESM ledger 2019/);
  });

  it.each([
    ['ROGUE25.input.json', 25, 'ROGUE25', 2019],
    ['HOUSTON17.input.json', 17, 'HOUSTON17', null],
  ])('committed manifest %s passes with its WESM ledger', (file, count, id, year) => {
    const m = JSON.parse(readFileSync(resolve(MDIR, file as string), 'utf8'));
    const wesm = WESM.get(id as string);
    expect(wesm).toBeTruthy();
    expect((wesm as Record<string, unknown>).acquisitionYear ?? null).toBe(year);
    const r = verifyManifest(m, { expectedCount: count, wesm });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
