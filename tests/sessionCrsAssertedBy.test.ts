/**
 * A catalogue CRS assertion names who asserted it (`assertedBy`). A session
 * file writes the whole resolved CRS, so reading it back must keep that name:
 * without it a restored `catalog-tile` record no longer says whose statement
 * the frame rests on, and it reads like an anonymous label.
 */
import { describe, it, expect } from 'vitest';
import { parseResolvedCrs } from '../src/io/sessionCrs';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const CATALOGUE: ResolvedCrs = {
  kind: 'projected',
  name: 'S-JTSK / Krovak East North',
  epsg: 5514,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'catalog-tile',
  assertedBy: 'dataset record',
  confidence: 'medium',
  userConfirmed: false,
};

describe('session CRS round trip', () => {
  it('keeps the catalogue assertion and its asserting party', () => {
    const back = parseResolvedCrs(JSON.parse(JSON.stringify(CATALOGUE)));
    expect(back?.source).toBe('catalog-tile');
    expect(back?.assertedBy).toBe('dataset record');
    expect(back?.userConfirmed).toBe(false);
  });

  it('keeps a user override distinct from a catalogue assertion', () => {
    const user: ResolvedCrs = { ...CATALOGUE, source: 'user-override', assertedBy: undefined, confidence: 'high', userConfirmed: true };
    const back = parseResolvedCrs(JSON.parse(JSON.stringify(user)));
    expect(back?.source).toBe('user-override');
    expect(back?.assertedBy).toBeUndefined();
    expect(back?.userConfirmed).toBe(true);
  });

  it('drops a non-string or empty assertedBy', () => {
    expect(parseResolvedCrs({ ...CATALOGUE, assertedBy: 7 })?.assertedBy).toBeUndefined();
    expect(parseResolvedCrs({ ...CATALOGUE, assertedBy: '' })?.assertedBy).toBeUndefined();
  });
});
