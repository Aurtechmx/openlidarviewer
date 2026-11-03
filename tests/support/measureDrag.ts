/**
 * measureDrag.ts: a MeasureController ready for vertex-handle drags in Node.
 *
 * The drag listens on `window` for the pointer that began it, so the fake
 * window records listeners and `fire` plays an event to them.
 */
import type { Measurement } from '../../src/render/measure/types';
import type { MeasureController } from '../../src/render/measure/MeasureController';
import { installFakeDom } from './measurePanelDom';

const listeners = new Map<string, Set<(e: unknown) => void>>();

/** Play a window event to every listener the drag attached. */
export const fire = (type: string, e: unknown = {}): void => {
  for (const fn of [...(listeners.get(type) ?? [])]) fn(e);
};

/** How many window listeners are still attached. */
export const openListeners = (): number => [...listeners.values()].reduce((n, set) => n + set.size, 0);

/** Install the fake DOM and the listener-recording window. Call from `beforeAll`. */
export function installDragWindow(): void {
  installFakeDom({ ns: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(fn); },
    removeEventListener: (t: string, fn: (e: unknown) => void) => { listeners.get(t)?.delete(fn); },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
  };
}

/** An active, Z-up, metre controller over a 100 × 100 px overlay, holding `m`. */
export async function controllerWith(m: Measurement): Promise<MeasureController> {
  const { MeasureController } = await import('../../src/render/measure/MeasureController');
  const measure = new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
  measure.setContext({ worldUp: [0, 0, 1], origin: null });
  measure.setCrsKnown(true);
  measure.setUnitToMetres(1);
  (measure.overlay as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  measure.loadMeasurements([m]);
  measure.setActive(true);
  return measure;
}

/** Press handle `vi` of measurement `mid` with pointer `pointerId` at (10, 10). */
export function pressHandle(measure: MeasureController, mid: string, vi: number, pointerId: number): void {
  (measure as unknown as { _handlePointerDown(e: unknown): void })._handlePointerDown({
    target: { dataset: { mid, vi: String(vi) } }, preventDefault: () => {}, clientX: 10, clientY: 10, pointerId,
  });
}
