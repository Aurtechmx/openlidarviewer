# iOS touch traces

Recorded by `scripts/ios-touch-trace.mjs`, driving `probe.html`
(`src/probe/iosTouchProbe.ts`) through a real XCUITest session on the iOS
simulator leg (`.github/workflows/ios-simulator.yml`). Do not edit by hand.
Regenerate by running that workflow and replacing every file here with a
fresh `ios-simulator-evidence` artifact's `ios-touch-traces/`.

Recording:

- Device: iPhone 17e
- iOS runtime: iOS 26.4 (`com.apple.CoreSimulator.SimRuntime.iOS-26-4`)
- Xcode: 26.6
- Runner image: macos26
- Run: [35792497399](https://github.com/Aurtechmx/openlidarviewer/actions/runs/35792497399)
- Date: 2026-09-22

`RESULT.json` is the run's own pass/fail summary. `tests/e2e/touchGestureReplay.spec.ts`
skips it when loading fixtures. The seven gesture files are each a full
event log, recording every `pointerdown/move/up`, the raw `touchstart/move/end/cancel`
Safari also delivers, WebKit's nonstandard `gesturestart/change/end`, and
the probe's own recogniser output, timestamped from session start.

## What passed

Six of seven: `pinchIn`, `pinchOut`, `twist`, `pan`, `oneFingerDrag`,
`wobble`. No zoom, no scroll, no `touchcancel`, and each recogniser fired
(or stayed silent) as intended. The probe itself never crashed and logged
no uncaught error. Running the same seven gestures through a page that
never asks WebGL for a context, this gives no reason to doubt the L13
GPU-driver theory.

## What did not: `doubleTap`

`doubleTap.json` is committed with its real `doubleTapAsIntended: false`
result, not patched to pass. Two single-finger taps were sent as one W3C
Actions pointer stream (down, up, pause 120 ms, down, up). What iOS
actually delivered was three overlapping touch identifiers, not two clean
ones. A first touch stayed down and drifted off-canvas over 134 ms. A
second touch landed at the same point and released 2 ms later while the
first was still down (`targetTouches: 2` at that instant, and a genuine
WebKit `gesturestart`/`gestureend` pair from the platform seeing two
simultaneous contacts). Only then came a third, clean, 3 ms tap, once the
first finger finally lifted. `TouchTapGate` reasonably refuses to call a
70+ ms two-finger overlap plus an off-canvas drift a "tap", so no
double-tap focus event ever fires. This reads as a WebDriverAgent
action-synthesis artifact for a fast down/up/pause/down/up on a single
pointer id, not a product bug: a real fingertip cannot occupy the same
touch stream twice at once. Recorded as-is, because it is what the
platform did.

## What Playwright's synthesized events do not carry

Coalescing. `pointer.getCoalescedEvents()` is non-empty on most moves
(`coalesced` in the log), real touch-scan-rate samples WebKit batches into
one dispatched event. A synthesized `PointerEvent` has none.

A doubled `gesturestart`/`gesturechange`/`gestureend` stream on every
two-finger trace. The underlying gesture is real, but the log doubles it:
this probe's own instrumentation (`wireRawObservers`) listens on both the
canvas and `window`, and WebKit's gesture events bubble to both, so halve
the `gesture` count in `counts` to read the platform's own rate.

Timing irregularity. Inter-event gaps are irregular, from single-digit ms
up to 68 ms between consecutive pointer events (see `wobble.json`), never
the fixed tick spacing a synthesized sequence would produce.

Touch radius and force. `radiusX` is a constant 22.788 across every trace
and every touch, the simulator's fixed default rather than a per-touch
measurement. `force` reads the same 22.788 on the opening `touchstart` of
a stream and 0 on everything after; the simulator has no pressure
hardware, so treat both fields as present but synthetic, not as evidence
about real finger contact area or pressure.

## Largest real inter-event gap

68 ms, in `wobble.json`, the largest across all seven traces.
`touchGestureReplay.spec.ts` clamps its replay's inter-event wait to
200 ms, documented there against this measurement. Nothing recorded here
is compressed by that clamp today; a future recording should be
re-checked against it before assuming that stays true.
