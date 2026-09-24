/**
 * flowClickGuard.test.ts — the honesty gate in front of pulseFrom/catchmentFrom.
 *
 * §18: a click must refuse rather than trace when the field it would read is
 * declared stale. The other two refusals are about the click itself: a cell
 * with no elevation, and an address outside the grid. All three are checked
 * against one real `runFlowPulse` result, over a terrain whose flow direction
 * is readable by eye.
 */
import { describe, expect, it } from 'vitest';

import { catchmentClick, traceClick } from '../src/simulation/flowPulse/flowClickGuard';
import { FLOW_PULSE_DEFAULTS, runFlowPulse } from '../src/simulation/flowPulse/flowPulseRunner';
import { CELL_OUTLET } from '../src/simulation/flowPulse/flowTypes';
import type { FlowPulseResult } from '../src/simulation/flowPulse/flowPulseRunner';
import {
  FLOW_PROJECTED_SCALE as projected,
  FLOW_TEST_IDENTITY as identity,
  flowDtmOf as dtmOf,
} from './helpers/flowFixtures';

/**
 * A 3x3 ridge sloping east, one NoData cell at (2,1): every cell in a row
 * routes to its east neighbour, and the east column is the outlet.
 *  9 8 7
 *  9 8 · (NoData)
 *  9 8 7
 */
function slope(): FlowPulseResult {
  const dtm = dtmOf([
    [9, 8, 7],
    [9, 8, null],
    [9, 8, 7],
  ]);
  const outcome = runFlowPulse(dtm, projected, { ...FLOW_PULSE_DEFAULTS }, identity);
  if (!outcome.ok) throw new Error('fixture must run');
  return outcome;
}

describe('traceClick', () => {
  it('traces the downstream path from a readable cell', () => {
    const result = slope();
    const trace = traceClick(result, { col: 0, row: 0 }, false);
    expect(trace.ok).toBe(true);
    if (!trace.ok) return;
    expect(Array.from(trace.path)).toEqual([0, 1, 2]); // row 0: (0,0)→(1,0)→(2,0)
    expect(trace.endStatus).toBe(CELL_OUTLET);
  });

  it('refuses a NoData cell with NO_VALID_CELL', () => {
    const result = slope();
    const trace = traceClick(result, { col: 2, row: 1 }, false);
    expect(trace.ok).toBe(false);
    if (trace.ok) return;
    expect(trace.code).toBe('NO_VALID_CELL');
    expect(trace.reason).toContain('no elevation');
  });

  it('refuses an address outside the grid with OUTSIDE_GRID', () => {
    const result = slope();
    const trace = traceClick(result, { col: 3, row: 0 }, false);
    expect(trace.ok).toBe(false);
    if (trace.ok) return;
    expect(trace.code).toBe('OUTSIDE_GRID');
  });

  it('refuses a stale field with STALE_INPUT, checked before the cell address', () => {
    const result = slope();
    // Stale AND outside the grid at once: staleness must win, so a caller
    // cannot read "outside the grid" as a promise that an in-bounds click on
    // the same stale field would have traced.
    const trace = traceClick(result, { col: 99, row: 99 }, true);
    expect(trace.ok).toBe(false);
    if (trace.ok) return;
    expect(trace.code).toBe('STALE_INPUT');
  });
});

describe('catchmentClick', () => {
  it('traces every cell draining to the outlet', () => {
    const result = slope();
    const trace = catchmentClick(result, { col: 2, row: 0 }, false);
    expect(trace.ok).toBe(true);
    if (!trace.ok) return;
    expect(trace.cells).toBe(3); // the whole top row drains through (2,0)
    expect(Array.from(trace.mask)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('refuses a NoData outlet with NO_VALID_CELL', () => {
    const result = slope();
    const trace = catchmentClick(result, { col: 2, row: 1 }, false);
    expect(trace.ok).toBe(false);
    if (trace.ok) return;
    expect(trace.code).toBe('NO_VALID_CELL');
  });

  it('refuses an outside-grid outlet with OUTSIDE_GRID', () => {
    const result = slope();
    const trace = catchmentClick(result, { col: -1, row: 0 }, false);
    expect(trace.ok).toBe(false);
    if (trace.ok) return;
    expect(trace.code).toBe('OUTSIDE_GRID');
  });

  it('refuses a stale field with STALE_INPUT', () => {
    const result = slope();
    const trace = catchmentClick(result, { col: 2, row: 0 }, true);
    expect(trace.ok).toBe(false);
    if (trace.ok) return;
    expect(trace.code).toBe('STALE_INPUT');
  });
});
