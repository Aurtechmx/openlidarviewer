/**
 * Two-epoch comparison requires a Z-up contract on BOTH sides.
 *
 * `compareEpochs` reads X/Y as the ground plane and Z as elevation — it says so
 * in its own docstring and hard-codes `verticalAxis: 'z'`. The terrain-analysis
 * path earns that: `Viewer.gatherTerrainPositions` runs up-axis detection and
 * rotates a Y-up mesh into the canonical frame before any analysis, and refuses
 * a scene that mixes a detected Y-up mesh with Z-up-by-spec sources.
 *
 * The compare path did neither. It passed `cloud.positions` in raw, so a Y-up
 * PLY/OBJ/glTF pair produced a ground filter, a DTM, a change surface, cut/fill
 * volumes and an ASCII raster built from one horizontal axis and the elevation
 * axis — all of it plausible-looking. A mixed Z-up/Y-up pair was not refused
 * either. The compare button is gated only on there being exactly two layers.
 */
import { describe, it, expect } from 'vitest';
import { prepareEpochFrames, epochUnitMismatchLines } from '../src/app/epochFramePrep';
import type { SourceFormat } from '../src/io/sniffFormat';

/** A CrsService stand-in that resolves both epochs to the same metre frame. */
const crsService = {
  resolveFor: () => ({
    kind: 'projected', name: 'UTM 12N', epsg: 32612,
    linearUnit: 'metre', linearUnitToMetres: 1,
    verticalDatum: 'EPSG:5703', source: 'wkt', confidence: 'high',
  }),
} as never;

const epoch = (name: string, sourceFormat: SourceFormat) => ({
  name,
  sourceFormat,
  positions: new Float32Array([0, 0, 0, 1, 1, 1]),
  sourceOrigin: [0, 0, 0] as const,
  metadata: null,
});

const prep = (fa: SourceFormat, fb: SourceFormat) =>
  prepareEpochFrames(crsService, epoch('a', fa), epoch('b', fb));

describe('epoch up-axis contract', () => {
  it('allows a survey-format pair, which is Z-up by specification', () => {
    for (const f of ['las', 'laz'] as SourceFormat[]) {
      const r = prep(f, f);
      expect(r.comparable, `${f} pair refused`).toBe(true);
      expect(r.reason).toBeNull();
    }
  });

  it('REFUSES a mesh pair, whose up-axis is not declared by the format', () => {
    for (const f of ['ply', 'obj', 'glb'] as SourceFormat[]) {
      const r = prep(f, f);
      expect(r.comparable, `${f} pair was compared`).toBe(false);
      expect(r.reason).toBe('up-axis');
    }
  });

  it('REFUSES a mixed survey/mesh pair, which may hold two different frames', () => {
    expect(prep('las', 'ply').comparable).toBe(false);
    expect(prep('ply', 'las').comparable).toBe(false);
    expect(prep('las', 'ply').reason).toBe('up-axis');
  });

  it('refuses when a format is not stated at all — silence is not evidence of Z-up', () => {
    const r = prepareEpochFrames(
      crsService,
      { name: 'a', positions: new Float32Array([0, 0, 0]), metadata: null },
      { name: 'b', positions: new Float32Array([0, 0, 0]), metadata: null },
    );
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe('up-axis');
  });

  it('the refusal names the real consequence, not just the axis', () => {
    const lines = epochUnitMismatchLines('A → B', 'up-axis');
    expect(lines[1]).toMatch(/horizontal axis/i);
    expect(lines[1]).toMatch(/height change/i);
    // And it stays distinct from the vertical-unit refusal it sits beside.
    expect(epochUnitMismatchLines('A → B', 'vertical-unit')[1]).toMatch(/vertical units/i);
    expect(lines[1]).not.toBe(epochUnitMismatchLines('A → B', 'vertical-unit')[1]);
  });

  it('defaults to the vertical-unit wording, so existing callers are unchanged', () => {
    expect(epochUnitMismatchLines('A → B')).toEqual(
      epochUnitMismatchLines('A → B', 'vertical-unit'),
    );
  });
});
