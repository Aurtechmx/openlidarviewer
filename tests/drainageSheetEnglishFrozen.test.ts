/**
 * drainageSheetEnglishFrozen.test.ts: the English drainage sheet, frozen.
 * The digests were taken before the sheet had other languages, so a language
 * change cannot alter an English sheet. A wanted change to the English sheet
 * updates them.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDrainageSheetModel, buildFlowDrainageSheetPdf, type FlowDrainageSheetOptions } from '../src/export/flowDrainageSheetPdf';
import { catchmentFrom, pulseFrom } from '../src/simulation/flowPulse/flowPulseRunner';
import { RAINFALL_DEFAULT } from '../src/simulation/flowPulse/rationalDischarge';
import { buildValley } from './support/watershedValley';
import { encodeStoredPng } from './support/storedPng';

const FONT_DIR = join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts');
const render = {
  loadFont: async (name: string) => new Uint8Array(await readFile(join(FONT_DIR, name))),
  encodePng: encodeStoredPng,
};
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex').slice(0, 16);

describe('the English drainage sheet is unchanged', () => {
  const v = buildValley();
  const outlet = v.model.sections[0]!.outlet;
  const base: FlowDrainageSheetOptions = {
    basename: 'valley', title: 'Valley test site', dtm: v.dtm, verticalToMetres: 1, rainfall: RAINFALL_DEFAULT, verticalUnitLabel: 'm',
    path: { cells: pulseFrom(v.result, 70 * 120 + 50) },
    catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet },
    generationDateIso: '2026-11-07T00:00:00.000Z',
    build: { version: '0.0.0', commit: 'abcdef0', dirty: false, builtAt: '2026-11-07T00:00:00Z', node: 'v0', channel: 'dev' },
  };
  const cases: Record<string, FlowDrainageSheetOptions> = {
    local: base,
    placed: {
      ...base, crsName: 'WGS 84 / UTM zone 14N', worldOrigin: { x: 512000, y: 2150000 },
      gridFrame: { originH1: 0, originH2: 0, cellSize: 3 }, linearUnit: 'metre',
      terrainCaveat: { verdict: 'Preview', interpolatedPercent: 6 },
    },
    bare: { ...base, rainfall: null, path: null, catchment: null, verticalToMetres: null, verticalUnitLabel: 'units' },
  };
  const FROZEN: Record<string, readonly [model: string, pdf: string]> = {
    local: ['c6b919c3eb831ebd', '10a0089cba50b4e4'],
    placed: ['829fde14adde49d3', '1c7e97442d971eca'],
    bare: ['8cdaef6cbb56082c', 'e78b3055479376a0'],
  };
  for (const [name, o] of Object.entries(cases)) {
    it(name, async () => {
      const m = buildDrainageSheetModel(v.result, o);
      const words = JSON.stringify([m.title, m.statusLines, m.summary, m.traced, m.depressions, m.catchmentStudyWithheld, m.map?.channelBasis, m.map?.crsText, m.map?.gridText]);
      expect([sha(words), sha(await buildFlowDrainageSheetPdf(v.result, o, render))]).toEqual(FROZEN[name]);
    }, 240_000);
  }
});
