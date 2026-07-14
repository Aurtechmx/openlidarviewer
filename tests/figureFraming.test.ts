/**
 * figureFraming.test.ts — the pure size/aspect planner behind
 * `Viewer.renderFigure` (`src/render/export/figureFraming.ts`).
 *
 * The planner is the honest-resolution equation: it turns a requested output
 * size (possibly partial) plus the live drawing-buffer size into the exact
 * pixel dimensions the renderer will be set to and the aspect the live
 * perspective camera must be re-projected with. Extracted as a leaf module —
 * same pattern as `orthoFraming.ts` — so the maths is a unit-tested contract
 * while the GPU round-trip in the Viewer stays a thin mechanical wrapper.
 */

import { test, expect } from 'vitest';
import {
  DEFAULT_FIGURE_WIDTH_PX,
  MAX_FIGURE_EDGE_PX,
  planFigureRender,
} from '../src/render/export/figureFraming';

const LIVE = { widthPx: 1920, heightPx: 1080 };

test('width-only requests derive the height from the live aspect', () => {
  const plan = planFigureRender({ widthPx: 2048 }, LIVE);
  expect(plan).not.toBeNull();
  // 2048 / (1920/1080) = 1152 exactly.
  expect(plan!.widthPx).toBe(2048);
  expect(plan!.heightPx).toBe(1152);
  expect(plan!.aspect).toBeCloseTo(2048 / 1152, 12);
});

test('height-only requests derive the width from the live aspect', () => {
  const plan = planFigureRender({ heightPx: 1080 }, LIVE);
  expect(plan).toEqual({ widthPx: 1920, heightPx: 1080, aspect: 1920 / 1080 });
});

test('explicit width + height are honoured exactly, whatever the live aspect', () => {
  const plan = planFigureRender({ widthPx: 3000, heightPx: 2000 }, LIVE);
  expect(plan).toEqual({ widthPx: 3000, heightPx: 2000, aspect: 1.5 });
});

test('with no request at all, the default width rides the live aspect', () => {
  const plan = planFigureRender({}, LIVE);
  expect(plan!.widthPx).toBe(DEFAULT_FIGURE_WIDTH_PX);
  expect(plan!.heightPx).toBe(Math.round(DEFAULT_FIGURE_WIDTH_PX / (1920 / 1080)));
});

test('a degenerate live canvas falls back to a square aspect', () => {
  const plan = planFigureRender({ widthPx: 2048 }, { widthPx: 0, heightPx: 0 });
  expect(plan).toEqual({ widthPx: 2048, heightPx: 2048, aspect: 1 });
});

test('fractional requests are rounded to whole pixels', () => {
  const plan = planFigureRender({ widthPx: 1000.4, heightPx: 750.6 }, LIVE);
  expect(plan).toEqual({ widthPx: 1000, heightPx: 751, aspect: 1000 / 751 });
});

test('the aspect always matches the ACTUAL output pixels, not the request', () => {
  // Rounding the derived edge can shift the aspect slightly off the live
  // ratio; the camera must be re-projected with the ratio of the real
  // drawing buffer or straight vertical lines lean in the export.
  const plan = planFigureRender({ widthPx: 333 }, { widthPx: 1000, heightPx: 700 });
  expect(plan!.heightPx).toBe(233); // round(333 * 700/1000)
  expect(plan!.aspect).toBeCloseTo(333 / 233, 12);
});

test('oversize requests are scaled down to the edge cap, preserving aspect', () => {
  const plan = planFigureRender({ widthPx: 20000, heightPx: 10000 }, LIVE);
  expect(plan!.widthPx).toBe(MAX_FIGURE_EDGE_PX);
  expect(plan!.heightPx).toBe(MAX_FIGURE_EDGE_PX / 2);
});

test('non-finite or non-positive requests are rejected as null', () => {
  expect(planFigureRender({ widthPx: Number.NaN }, LIVE)).toBeNull();
  expect(planFigureRender({ widthPx: Number.POSITIVE_INFINITY }, LIVE)).toBeNull();
  expect(planFigureRender({ widthPx: 0 }, LIVE)).toBeNull();
  expect(planFigureRender({ heightPx: -5 }, LIVE)).toBeNull();
  expect(planFigureRender({ widthPx: 2048, heightPx: 0.2 }, LIVE)).toBeNull();
});

test('a tiny but valid request survives (1 px is a legal PNG)', () => {
  const plan = planFigureRender({ widthPx: 1, heightPx: 1 }, LIVE);
  expect(plan).toEqual({ widthPx: 1, heightPx: 1, aspect: 1 });
});
