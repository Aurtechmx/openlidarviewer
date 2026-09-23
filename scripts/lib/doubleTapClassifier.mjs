/**
 * doubleTapClassifier.mjs — what to conclude from one recorded doubleTap
 * gesture trace, for scripts/ios-touch-trace.mjs's iOS simulator leg.
 *
 * WHY THIS EXISTS. Two clean single-finger taps sent as one W3C Actions
 * pointer stream (down, up, pause, down, up) do not arrive at Safari that
 * way: WebDriverAgent delivers the first "tap" as two overlapping pointer
 * ids (a second pointerdown while the first is still down) plus a drift
 * off the original point, before the stream's actual second tap lands
 * clean. src/render/touchTapGate.ts correctly refuses to call that a tap
 * (TouchTapGate's `_seqHadTwo` and `_moved`), so no `doubletap` event ever
 * fires — the instrument cannot deliver the gesture it was asked for, not
 * OLV failing to recognise one. Left as an ordinary boolean pass/fail, that
 * reads as a permanently red product bug; classified here, it is a named,
 * mechanism-checked instrument limitation that cannot be satisfied by
 * accident and cannot be ignored by accident either — a genuinely FIXED
 * WebDriverAgent (a `doubletap` event actually recorded) fails loudly
 * instead of just going green.
 *
 * Pure: no IO, no DOM, no process. Given the same event log and
 * assertions, always the same verdict.
 */

/** @typedef {{ kind: string, type?: string, pointerId?: number }} TraceEvent */

export const DOUBLE_TAP_CLASSIFICATIONS = /** @type {const} */ ({
  UNEXPECTED_PASS: 'unexpectedly-passing',
  INSTRUMENT_LIMITATION: 'instrument-limitation',
  FAILED: 'failed',
});

/**
 * The characterised WebDriverAgent artifact: a pointerdown for a SECOND
 * pointer id arriving before the FIRST pointer id's own pointerup — i.e.
 * within what should have been the gesture's first, single-finger tap. A
 * real fingertip cannot occupy the same touch stream twice at once, so this
 * shape only comes from action-synthesis, never from a genuine double-tap
 * (two SEPARATE down/up pairs on the same id, one after another).
 *
 * @param {ReadonlyArray<TraceEvent>} events
 * @returns {boolean}
 */
export function hasOverlappingSecondPointerArtifact(events) {
  let firstDownId = null;
  let firstUpSeen = false;
  for (const e of events) {
    if (e.kind !== 'pointer') continue;
    if (e.type === 'pointerdown') {
      if (firstDownId === null) {
        firstDownId = e.pointerId;
      } else if (!firstUpSeen && e.pointerId !== firstDownId) {
        return true; // a second id went down while the first was still active
      }
    } else if (e.type === 'pointerup' && e.pointerId === firstDownId) {
      firstUpSeen = true;
    }
  }
  return false;
}

/**
 * Classify one recorded doubleTap trace.
 *
 * `events` is the gesture's full event log (as `getLog()` on the probe
 * returns it). `assertions` are the four checks `runGesture` already
 * computes for every gesture — `noZoom`, `noScroll`, `noTouchCancel`,
 * `recognizerAsIntended` — evaluated here WITHOUT any double-tap-specific
 * assertion folded in, since that is exactly what this function decides.
 *
 * Three outcomes:
 *   - a `doubletap` event WAS recorded: the instrument can complete the
 *     gesture now. `UNEXPECTED_PASS` — `ok:false`, `failStep:true`. This is
 *     a deliberate step failure: the fixture and the expectation this
 *     module encodes both need revisiting, not a value to accept quietly.
 *   - no `doubletap` event, the characterised overlapping-pointer artifact
 *     is present, and the four other assertions all hold: `INSTRUMENT_LIMITATION`
 *     — `ok:false`, `failStep:false`. Never a pass, but not a product
 *     failure either; the caller records it as its own third state.
 *   - anything else (no artifact and no doubletap, or the artifact present
 *     alongside some other broken assertion): `FAILED` — `ok:false`,
 *     `failStep:true`, same as an unclassified failure always was.
 *
 * @param {ReadonlyArray<TraceEvent>} events
 * @param {{ noZoom: boolean, noScroll: boolean, noTouchCancel: boolean, recognizerAsIntended: boolean }} assertions
 * @returns {{ classification: string, ok: false, failStep: boolean, detail: string }}
 */
export function classifyDoubleTap(events, assertions) {
  const gotDoubleTap = events.some((e) => e.kind === 'doubletap');
  if (gotDoubleTap) {
    return {
      classification: DOUBLE_TAP_CLASSIFICATIONS.UNEXPECTED_PASS,
      ok: false,
      failStep: true,
      detail: 'a doubletap event was recorded — the instrument can complete this gesture now; the "instrument limitation" expectation must be revisited',
    };
  }

  const othersHold = !!(
    assertions
    && assertions.noZoom
    && assertions.noScroll
    && assertions.noTouchCancel
    && assertions.recognizerAsIntended
  );
  const artifact = hasOverlappingSecondPointerArtifact(events);

  if (artifact && othersHold) {
    return {
      classification: DOUBLE_TAP_CLASSIFICATIONS.INSTRUMENT_LIMITATION,
      ok: false,
      failStep: false,
      detail: 'no doubletap event; the characterised overlapping-pointer WebDriverAgent artifact is present and the other assertions hold — the instrument cannot deliver this gesture',
    };
  }

  return {
    classification: DOUBLE_TAP_CLASSIFICATIONS.FAILED,
    ok: false,
    failStep: true,
    detail: artifact
      ? 'the overlapping-pointer artifact is present but another assertion failed — not the characterised instrument limitation'
      : 'no doubletap event and no characterised overlapping-pointer artifact — unexplained failure',
  };
}
