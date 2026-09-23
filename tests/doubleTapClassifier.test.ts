/**
 * The iOS doubleTap leg used a plain boolean pass/fail for a gesture that
 * WebDriverAgent cannot deliver cleanly (see scripts/lib/doubleTapClassifier.mjs's
 * header), so the step was red on every run and could never earn the leg's
 * 20-consecutive-passes ledger entry. These tests exercise the classifier
 * directly: the real committed fixture must read as the characterised
 * instrument limitation, a constructed log with a genuine `doubletap` event
 * must fail loudly as unexpectedly passing, and every other shape must fail
 * as an ordinary, unclassified failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs module, no declaration file
import { classifyDoubleTap, hasOverlappingSecondPointerArtifact, DOUBLE_TAP_CLASSIFICATIONS } from '../scripts/lib/doubleTapClassifier.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/ios-traces/doubleTap.json', import.meta.url));

const HOLDING_ASSERTIONS = {
  noZoom: true,
  noScroll: true,
  noTouchCancel: true,
  recognizerAsIntended: true,
};

/** A clean, non-overlapping down/up pair on a fresh pointer id. */
function cleanTap(id: number) {
  return [
    { kind: 'pointer', type: 'pointerdown', pointerId: id },
    { kind: 'pointer', type: 'pointerup', pointerId: id },
  ];
}

describe('hasOverlappingSecondPointerArtifact', () => {
  it('detects a second pointerdown while the first pointer is still down', () => {
    const events = [
      { kind: 'pointer', type: 'pointerdown', pointerId: 1 },
      { kind: 'pointer', type: 'pointerdown', pointerId: 2 }, // 1 never went up yet
      { kind: 'pointer', type: 'pointerup', pointerId: 2 },
      { kind: 'pointer', type: 'pointerup', pointerId: 1 },
    ];
    expect(hasOverlappingSecondPointerArtifact(events)).toBe(true);
  });

  it('is false for two clean, sequential single-finger taps', () => {
    const events = [...cleanTap(1), ...cleanTap(2)];
    expect(hasOverlappingSecondPointerArtifact(events)).toBe(false);
  });

  it('ignores non-pointer kinds and a lone tap', () => {
    const events = [
      { kind: 'touch', type: 'touchstart' },
      ...cleanTap(1),
      { kind: 'gesture', type: 'gesturestart' },
    ];
    expect(hasOverlappingSecondPointerArtifact(events)).toBe(false);
  });
});

describe('classifyDoubleTap — the committed fixture', () => {
  it('classifies tests/fixtures/ios-traces/doubleTap.json as an instrument limitation', () => {
    const trace = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const { noZoom, noScroll, noTouchCancel, recognizerAsIntended } = trace.assertions;
    const result = classifyDoubleTap(trace.events, { noZoom, noScroll, noTouchCancel, recognizerAsIntended });
    expect(result.classification).toBe(DOUBLE_TAP_CLASSIFICATIONS.INSTRUMENT_LIMITATION);
    expect(result.ok).toBe(false);
    expect(result.failStep).toBe(false);
  });
});

describe('classifyDoubleTap — (a) a doubletap event was recorded', () => {
  it('classifies as unexpectedly passing and fails the step, even with the artifact present', () => {
    const events = [
      { kind: 'pointer', type: 'pointerdown', pointerId: 1 },
      { kind: 'pointer', type: 'pointerdown', pointerId: 2 }, // artifact still present
      { kind: 'pointer', type: 'pointerup', pointerId: 2 },
      { kind: 'pointer', type: 'pointerup', pointerId: 1 },
      { kind: 'doubletap', x: 10, y: 10 },
    ];
    const result = classifyDoubleTap(events, HOLDING_ASSERTIONS);
    expect(result.classification).toBe(DOUBLE_TAP_CLASSIFICATIONS.UNEXPECTED_PASS);
    expect(result.ok).toBe(false);
    expect(result.failStep).toBe(true);
  });

  it('classifies as unexpectedly passing even with two clean taps and no artifact', () => {
    const events = [...cleanTap(1), ...cleanTap(2), { kind: 'doubletap', x: 10, y: 10 }];
    const result = classifyDoubleTap(events, HOLDING_ASSERTIONS);
    expect(result.classification).toBe(DOUBLE_TAP_CLASSIFICATIONS.UNEXPECTED_PASS);
    expect(result.failStep).toBe(true);
  });
});

describe('classifyDoubleTap — (c) any other outcome fails the step', () => {
  it('fails when there is no doubletap event and no characterised artifact', () => {
    const events = [...cleanTap(1), ...cleanTap(2)];
    const result = classifyDoubleTap(events, HOLDING_ASSERTIONS);
    expect(result.classification).toBe(DOUBLE_TAP_CLASSIFICATIONS.FAILED);
    expect(result.ok).toBe(false);
    expect(result.failStep).toBe(true);
  });

  it('fails when the artifact is present but another assertion is broken (e.g. a zoom)', () => {
    const events = [
      { kind: 'pointer', type: 'pointerdown', pointerId: 1 },
      { kind: 'pointer', type: 'pointerdown', pointerId: 2 },
      { kind: 'pointer', type: 'pointerup', pointerId: 2 },
      { kind: 'pointer', type: 'pointerup', pointerId: 1 },
    ];
    const result = classifyDoubleTap(events, { ...HOLDING_ASSERTIONS, noZoom: false });
    expect(result.classification).toBe(DOUBLE_TAP_CLASSIFICATIONS.FAILED);
    expect(result.failStep).toBe(true);
  });

  it('fails when the artifact is present but the recognizer misfired', () => {
    const events = [
      { kind: 'pointer', type: 'pointerdown', pointerId: 1 },
      { kind: 'pointer', type: 'pointerdown', pointerId: 2 },
      { kind: 'pointer', type: 'pointerup', pointerId: 2 },
      { kind: 'pointer', type: 'pointerup', pointerId: 1 },
    ];
    const result = classifyDoubleTap(events, { ...HOLDING_ASSERTIONS, recognizerAsIntended: false });
    expect(result.classification).toBe(DOUBLE_TAP_CLASSIFICATIONS.FAILED);
    expect(result.failStep).toBe(true);
  });
});
