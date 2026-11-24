/**
 * drainageSheetFallbackFonts.test.ts: without the report fonts the drainage
 * sheet is set in Helvetica, and a character Helvetica lacks does not stop it.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildFlowDrainageSheetPdf } from '../src/export/flowDrainageSheetPdf';
import { catchmentFrom, pulseFrom } from '../src/simulation/flowPulse/flowPulseRunner';
import { RAINFALL_DEFAULT } from '../src/simulation/flowPulse/rationalDischarge';
import { buildValley } from './support/watershedValley';
import { encodeStoredPng } from './support/storedPng';

describe('the drainage sheet without its fonts', () => {
  it.each(['en', 'es'] as const)('is still made in %s with a title Helvetica cannot write', async (lang) => {
    const v = buildValley();
    const outlet = v.model.sections[0]!.outlet;
    const bytes = await buildFlowDrainageSheetPdf(v.result, {
      basename: 'valley', title: 'Ēast 東 site', dtm: v.dtm, verticalToMetres: 1, rainfall: RAINFALL_DEFAULT, verticalUnitLabel: 'm',
      path: { cells: pulseFrom(v.result, 70 * 120 + 50) }, catchment: { mask: catchmentFrom(v.result, outlet), outletCell: outlet },
      generationDateIso: '2026-11-07T00:00:00.000Z', locale: { lang, numberStyle: 'point' },
    }, { loadFont: async () => { throw new Error('no font'); }, encodePng: encodeStoredPng });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  }, 60_000);
});
