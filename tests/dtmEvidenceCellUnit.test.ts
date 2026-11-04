import { describe, expect, it } from 'vitest';
import { dtmCellsEvidenceText, dtmMeasuredParameterSet, liveDtmGridRule } from '../src/validation/scopedEvidence';

/**
 * `DtmGrid.cellSizeM` is in the scan's horizontal unit despite its name. The
 * studied range is 0.1 to 10 m, so the rule has to convert before it judges.
 */
describe('live DTM grid rule reads the cell size in metres', () => {
  it('converts a cell size stated in feet before judging the studied range', () => {
    const feet = 5280 / 256; // 20.6 ft is 6.29 m, inside the range
    expect(dtmMeasuredParameterSet(liveDtmGridRule({ cellSizeM: feet, cellUnitToMetres: 0.3048 }))).toBe('PS-DTM-MEDIAN-RANGE-0P1-10-ORIGINMIN');
    // 0.2 ft is 0.061 m, outside the range
    expect(dtmCellsEvidenceText(liveDtmGridRule({ cellSizeM: 0.2, cellUnitToMetres: 0.3048 }))).toMatch(/^measured cells not covered/);
  });

  it('a grid with no resolved metre scale is not covered', () => {
    expect(dtmCellsEvidenceText(liveDtmGridRule({ cellSizeM: 1, cellUnitToMetres: null }))).toMatch(/^measured cells not covered/);
  });

  it('a grid that does not say is read as metres, as an older cached core does', () => {
    expect(dtmCellsEvidenceText(liveDtmGridRule({ cellSizeM: 0.5 }))).toMatch(/^E4 /);
  });
});
