/**
 * railIntent.test.ts
 *
 * The rail-focus decision behind the router's `focus` flag: a click or key in
 * the rail counts even when the engine leaves focus on <body> (Safari), a
 * programmatic navigation from outside the rail does not, and a focused text
 * field is never taken over.
 */
import { describe, it, expect } from 'vitest';
import { createRailIntent } from '../src/app/workspace/workspaceRouter';

type Listener = (e: Event) => void;
function fakeDoc() {
  const listeners = new Map<string, Listener[]>();
  const doc = {
    activeElement: null as unknown,
    addEventListener: (t: string, fn: Listener) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
    removeEventListener: (t: string, fn: Listener) => listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== fn)),
    fire: (t: string, target: unknown) => (listeners.get(t) ?? []).forEach((fn) => fn({ target } as unknown as Event)),
    count: (t: string) => (listeners.get(t) ?? []).length,
  };
  return doc;
}
const node = (tag = 'BUTTON', extra: Record<string, unknown> = {}) => ({ tagName: tag, ...extra });

function setup() {
  const inside = node();
  const outside = node();
  const body = node('BODY');
  const rail = { contains: (n: unknown) => n === inside } as unknown as HTMLElement;
  const doc = fakeDoc();
  doc.activeElement = body;
  let t = 0;
  const intent = createRailIntent(rail, doc as unknown as Document, () => t);
  return { inside, outside, doc, intent, advance: (ms: number) => { t += ms; } };
}

describe('createRailIntent', () => {
  it('counts a mouse click in the rail when focus stays on <body>', () => {
    const { inside, doc, intent } = setup();
    doc.fire('pointerdown', inside);
    expect(intent.startedInRail()).toBe(true);
  });

  it('counts a key press in the rail and a focused rail control', () => {
    const { inside, doc, intent } = setup();
    doc.fire('keydown', inside);
    expect(intent.startedInRail()).toBe(true);
    const s = setup();
    s.doc.activeElement = s.inside;
    expect(s.intent.startedInRail()).toBe(true);
  });

  it('does not count a programmatic navigation from outside the rail', () => {
    const { outside, doc, intent, inside, advance } = setup();
    expect(intent.startedInRail()).toBe(false);
    doc.fire('keydown', outside);
    expect(intent.startedInRail()).toBe(false);
    doc.fire('pointerdown', inside);
    advance(5000); // a shortcut or dock action long after the last rail click
    expect(intent.startedInRail()).toBe(false);
  });

  it('never takes focus from a text field', () => {
    const { inside, doc, intent } = setup();
    doc.fire('pointerdown', inside);
    doc.activeElement = node('INPUT', { type: 'text' });
    expect(intent.startedInRail()).toBe(false);
    doc.activeElement = node('TEXTAREA');
    expect(intent.startedInRail()).toBe(false);
    doc.activeElement = node('DIV', { isContentEditable: true });
    expect(intent.startedInRail()).toBe(false);
  });

  it('removes its listeners on dispose', () => {
    const { doc, intent } = setup();
    intent.dispose();
    expect(doc.count('pointerdown') + doc.count('keydown')).toBe(0);
  });
});
