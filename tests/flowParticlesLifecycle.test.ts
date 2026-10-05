/**
 * Opening and closing Flow Pulse releases what its particle layer holds:
 * the IntersectionObserver, the document visibilitychange listener and the
 * reduced-motion media-query listener.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { installRecordingDom } from './helpers/recordingDom';
import { flowDtmOfCounted as dtmOf } from './helpers/flowFixtures';

const live = { observers: 0, docListeners: 0, mediaListeners: 0 };

beforeAll(() => {
  installRecordingDom();
  vi.stubGlobal('HTMLInputElement', class HTMLInputElement {});
  vi.stubGlobal('HTMLButtonElement', class HTMLButtonElement {});
  const doc = (globalThis as unknown as { document: Record<string, unknown> }).document;
  doc.addEventListener = (type: string) => { if (type === 'visibilitychange') live.docListeners++; };
  doc.removeEventListener = (type: string) => { if (type === 'visibilitychange') live.docListeners--; };
  vi.stubGlobal('IntersectionObserver', class {
    constructor() { live.observers++; }
    observe(): void {}
    disconnect(): void { live.observers--; }
  });
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => { live.mediaListeners++; },
    removeEventListener: () => { live.mediaListeners--; },
  }));
});
afterAll(() => vi.unstubAllGlobals());

describe('Flow Pulse particle lifecycle', () => {
  it('returns observer and listener counts to baseline after the lab opens and closes twice', async () => {
    const { setLabPageHost } = await import('../src/ui/labSurface');
    const { openFlowPulseLab } = await import('../src/ui/fieldSimulation/flowPulseLab');
    let close: (() => void) | undefined;
    setLabPageHost((_lab, body, onClose) => { close = onClose; return { element: body, close: () => onClose?.() }; });
    const input = {
      result: { dtm: dtmOf([[3, 2, 1], [3, 2, 1], [3, 2, 1]]), horizontalScaleResolved: true } as never,
      isGeographic: false, worldOriginY: null, resolvedUnitToMetres: 1, layerId: 'scan-1', filename: 'site',
    };
    const baseline = { ...live };
    for (let i = 0; i < 2; i++) {
      openFlowPulseLab(input as never);
      expect(live.observers).toBe(baseline.observers + 1);
      expect(live.docListeners).toBe(baseline.docListeners + 1);
      expect(live.mediaListeners).toBe(baseline.mediaListeners + 1);
      close?.();
      expect(live).toEqual(baseline);
    }
    setLabPageHost(null);
  });
});
