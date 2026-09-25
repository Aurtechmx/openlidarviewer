/**
 * navCanvasStubs.ts — minimal DOM stand-ins for constructing a NavController
 * in a unit test (no jsdom in this repo): an event target and an 800×600
 * canvas that accepts the pointer calls NavController makes.
 */

export function stubTarget(): { addEventListener: () => void; removeEventListener: () => void } {
  return { addEventListener: () => {}, removeEventListener: () => {} };
}

export function stubCanvas(): HTMLCanvasElement {
  return {
    ...stubTarget(),
    style: {},
    clientWidth: 800,
    clientHeight: 600,
    contains: () => false,
    releasePointerCapture: () => {},
    setPointerCapture: () => {},
    requestPointerLock: () => Promise.resolve(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  } as unknown as HTMLCanvasElement;
}
