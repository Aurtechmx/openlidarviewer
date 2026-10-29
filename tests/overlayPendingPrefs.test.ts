/**
 * overlayPendingPrefs.test.ts
 *
 * A Created layers preference restored from a session is kept until its
 * overlay is generated again, including across further saves and reopens
 * (normal sessions and the recovery journal share one writer and one
 * reader). Malformed input is dropped, closing the scan forgets pending
 * preferences, and the Data tab row follows the true overlay state.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { serializeSession, parseSession } from '../src/io/session';
import type { InspectionSession } from '../src/io/session';
import { createOverlayRegistry, sanitizeOverlayPrefs, type OverlayRegistry } from '../src/app/overlayRegistry';
import { clearPendingSessionRestore } from '../src/app/pendingSessionRestore';
import { overlayRegistry } from '../src/app/overlayRegistry';
import { createOverlaySwitches } from '../src/ui/OverlaySwitches';
import { FakeEl, installFakeDom } from './support/measurePanelDom';

beforeAll(() => { installFakeDom({ fragment: true }); });

function base(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return { upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements: [], annotations: [] };
}

function owner(reg: OverlayRegistry, id: string) {
  const s = { available: false, visible: true };
  reg.register({ id, label: id, isAvailable: () => s.available, get: () => s.visible, set: (v) => { s.visible = v; } });
  return s;
}

/** Save the registry state and reopen it in a fresh app. */
function saveAndReopen(reg: OverlayRegistry, ids: string[]) {
  const saved = parseSession(serializeSession({ ...base(), overlayVisibility: reg.snapshot() }));
  const reg2 = createOverlayRegistry();
  const owners = Object.fromEntries(ids.map((id) => [id, owner(reg2, id)]));
  reg2.restore(saved.overlayVisibility);
  return { reg: reg2, owners, saved };
}

describe('pending overlay preferences', () => {
  it('keeps a hidden preference through save and reopen before regeneration', () => {
    const reg = createOverlayRegistry();
    owner(reg, 'contours');
    reg.restore({ contours: false });
    expect(reg.snapshot()).toEqual({ contours: false });
    const { reg: reg2, owners } = saveAndReopen(reg, ['contours']);
    owners.contours.available = true;
    reg2.changed();
    expect(owners.contours.visible).toBe(false);
  });

  it('keeps a visible preference too', () => {
    const reg = createOverlayRegistry();
    reg.restore({ 'flow-drainage': true });
    const { reg: reg2, owners } = saveAndReopen(reg, ['flow-drainage']);
    owners['flow-drainage'].visible = false;
    owners['flow-drainage'].available = true;
    reg2.changed();
    expect(owners['flow-drainage'].visible).toBe(true);
  });

  it('partial regeneration: the regenerated overlay reports its own state, the rest stay pending', () => {
    const reg = createOverlayRegistry();
    const c = owner(reg, 'contours');
    owner(reg, 'terrain-access-map');
    reg.restore({ contours: false, 'terrain-access-map': false });
    c.available = true;
    reg.changed();
    expect(c.visible).toBe(false);
    c.visible = true; // the user shows it again after regeneration
    reg.changed();
    expect(reg.snapshot()).toEqual({ contours: true, 'terrain-access-map': false });
  });

  it('survives repeated save and reopen', () => {
    let reg = createOverlayRegistry();
    reg.restore({ contours: false, 'flow-drainage': true });
    for (let i = 0; i < 3; i += 1) reg = saveAndReopen(reg, ['contours', 'flow-drainage']).reg;
    expect(reg.snapshot()).toEqual({ contours: false, 'flow-drainage': true });
  });

  it('recovery: the journal text is the same session JSON, so pending preferences survive it', () => {
    const reg = createOverlayRegistry();
    reg.restore({ contours: false });
    const journal = serializeSession({ ...base(), overlayVisibility: reg.snapshot() });
    expect(parseSession(journal).overlayVisibility).toEqual({ contours: false });
  });

  it('drops malformed input on restore and on parse', () => {
    const big: Record<string, boolean> = {};
    for (let i = 0; i < 100; i += 1) big[`o${i}`] = false;
    const evil = JSON.parse('{"__proto__": false, "constructor": "x", "contours": false, "Bad Id!": true, "n": 1}');
    expect(sanitizeOverlayPrefs(evil)).toEqual({ contours: false });
    expect(Object.keys(sanitizeOverlayPrefs(big) ?? {})).toHaveLength(32);
    expect(sanitizeOverlayPrefs([true])).toBeNull();
    expect(sanitizeOverlayPrefs('contours')).toBeNull();
    const reg = createOverlayRegistry();
    reg.restore(evil);
    reg.restore(big); // replaces, never merges
    expect(Object.keys(reg.snapshot())).toHaveLength(32);
    reg.restore(evil);
    expect(reg.snapshot()).toEqual({ contours: false });
    expect(({} as Record<string, unknown>).contours).toBeUndefined();
    const doc = JSON.parse(serializeSession(base()));
    doc.overlayVisibility = evil;
    expect(parseSession(JSON.stringify(doc)).overlayVisibility).toEqual({ contours: false });
  });

  it('32 made-up pending ids do not push real overlay states out of a save', () => {
    const fake: Record<string, boolean> = {};
    for (let i = 0; i < 32; i += 1) fake[`fake-${i}`] = true;
    const reg = createOverlayRegistry();
    const c = owner(reg, 'contours');
    reg.restore(fake);
    c.available = true;
    c.visible = false;
    reg.changed();
    const snap = reg.snapshot();
    expect(snap.contours).toBe(false);
    expect(Object.keys(snap)).toHaveLength(32);
    const { reg: reg2, owners } = saveAndReopen(reg, ['contours']);
    owners.contours.available = true;
    reg2.changed();
    expect(owners.contours.visible).toBe(false);
  });

  it('a pending preference for a registered overlay outranks unknown pending ids', () => {
    const prefs: Record<string, boolean> = { 'terrain-access-map': false };
    for (let i = 0; i < 31; i += 1) prefs[`fake-${i}`] = true;
    const reg = createOverlayRegistry();
    const c = owner(reg, 'contours');
    owner(reg, 'terrain-access-map');
    reg.restore(prefs);
    c.available = true;
    reg.changed();
    const snap = reg.snapshot();
    expect(snap.contours).toBe(true);
    expect(snap['terrain-access-map']).toBe(false);
    expect(Object.keys(snap)).toHaveLength(32);
  });

  it('an older session without the field clears pending preferences', () => {
    const reg = createOverlayRegistry();
    reg.restore({ contours: false });
    reg.restore(undefined);
    expect(reg.snapshot()).toEqual({});
  });

  it('closing the scan forgets pending preferences', () => {
    overlayRegistry.restore({ contours: false });
    clearPendingSessionRestore();
    expect(overlayRegistry.snapshot()).toEqual({});
  });

  it('the Created layers row shows the applied preference', () => {
    const reg = createOverlayRegistry();
    const c = owner(reg, 'contours');
    const ui = createOverlaySwitches(reg);
    reg.restore({ contours: false });
    c.available = true;
    reg.changed();
    const root = ui.element as unknown as FakeEl;
    const find = (n: FakeEl): FakeEl | null => (n.tagName === 'input' ? n : n.children.map(find).find(Boolean) ?? null);
    const cb = find(root)!;
    expect(cb.checked).toBe(false);
    expect(c.visible).toBe(false);
    ui.dispose();
  });
});
