/**
 * measureA11yStates.test.ts: the measure kind buttons say which one is chosen
 * through aria-pressed, and a new result card announces "{name}: {value}.
 * {caveat}" through the application's one polite region instead of a live
 * region of its own, which a hidden card would silence.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { MeasureController as MC } from '../src/render/measure/MeasureController';
import { MeasureResultCard } from '../src/ui/MeasureResultCard';
import type { ResultModel } from '../src/app/measureResultModel';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

const region = new FakeEl('span');

beforeAll(() => {
  installFakeDom({ ns: true });
  (globalThis as unknown as { document: Record<string, unknown> }).document.querySelector = (sel: string) =>
    sel.includes('[role="status"]') ? region : null;
});

async function controller(): Promise<MC> {
  const { MeasureController } = await import('../src/render/measure/MeasureController');
  return new MeasureController({ onExit: () => {} } as unknown as ConstructorParameters<typeof MeasureController>[0]);
}

const pressed = (measure: MC): Record<string, string | null> =>
  Object.fromEntries((measure.hint as unknown as FakeEl).querySelectorAll('.olv-mkind').map((b) => [b.getAttribute('aria-label'), b.getAttribute('aria-pressed')]));

describe('the kind buttons', () => {
  it('carry aria-pressed for the chosen kind, following setKind', async () => {
    const measure = await controller();
    let state = pressed(measure);
    expect(state['Distance']).toBe('true');
    expect(Object.values(state).filter((v) => v === 'true')).toHaveLength(1);
    measure.setKind('area');
    state = pressed(measure);
    expect(state['Area']).toBe('true');
    expect(state['Distance']).toBe('false');
  });
});

describe('the result card', () => {
  const model = (over: Partial<ResultModel> = {}): ResultModel => ({
    id: 'd1', kind: 'distance', name: 'Line 1', value: '4.00 m', status: 'ok', caveat: null, copyText: 'Line 1: 4.00 m', canClip: false, ...over,
  });
  const noop = (): void => {};

  it('announces a new result with its caveat through the shared polite region, once', () => {
    const card = new MeasureResultCard({ onCopy: noop, onOpenDetails: noop, onUseAsClip: noop, onDismiss: noop, onDelete: noop });
    const spoken: string[] = [];
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(region), 'textContent')!;
    Object.defineProperty(region, 'textContent', { get() { return desc.get!.call(region); }, set(v: string) { if (v) spoken.push(v); desc.set!.call(region, v); } });
    card.show(model());
    expect(spoken).toEqual(['Line 1: 4.00 m.']);
    card.show(model()); // the same result again: nothing new to say
    expect(spoken).toHaveLength(1);
    card.show(model({ id: 'v1', name: 'Volume 1', value: '12 m³', caveat: 'approximate; the shared datum is unresolved' }));
    expect(spoken.at(-1)).toBe('Volume 1: 12 m³. approximate; the shared datum is unresolved');
    // No live region of its own.
    const value = (card.element as unknown as FakeEl).querySelectorAll('.olv-result-value')[0]!;
    expect(value.getAttribute('aria-live')).toBeNull();
    expect(value.getAttribute('role')).toBeNull();
  });
});
