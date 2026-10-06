import { describe, it, expect } from 'vitest';
import { parseEpsgField, epsgFieldProblem } from '../src/convert/epsg';

describe('parseEpsgField', () => {
  it('accepts a whole code, with or without the EPSG: prefix', () => {
    expect(parseEpsgField('32614')).toBe(32614);
    expect(parseEpsgField(' 4326 ')).toBe(4326);
    expect(parseEpsgField('EPSG:26913')).toBe(26913);
    expect(parseEpsgField('epsg:3857')).toBe(3857);
  });
  it('refuses text that is not wholly a code', () => {
    for (const bad of ['4326junk', '32614.5', '1e3', '-4326', '0', '', 'EPSG:', '12 34', '0x10', '99999999999999999999']) {
      expect(parseEpsgField(bad)).toBeNull();
    }
  });
  it('names the problem only for non-empty invalid text', () => {
    expect(epsgFieldProblem('', 'target')).toBeNull();
    expect(epsgFieldProblem('32614', 'target')).toBeNull();
    expect(epsgFieldProblem('1e3', 'target')).toMatch(/target EPSG must be a whole number/);
  });
});
