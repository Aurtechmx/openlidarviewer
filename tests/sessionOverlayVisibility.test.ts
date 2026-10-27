/**
 * sessionOverlayVisibility.test.ts
 *
 * The Created layers state in the saved session: it round-trips, a file
 * written before the field existed still loads with none, and a malformed
 * entry is dropped rather than thrown. The restored state then reaches the
 * overlay registry, which applies it when the overlay is generated again.
 */
import { describe, it, expect } from 'vitest';
import { serializeSession, parseSession } from '../src/io/session';
import type { InspectionSession } from '../src/io/session';
import { createOverlayRegistry } from '../src/app/overlayRegistry';

function base(): Omit<InspectionSession, 'app' | 'kind' | 'version'> {
  return { upAxis: 'z', origin: [0, 0, 0], unitSystem: 'metric', views: [], measurements: [], annotations: [] };
}

describe('session overlay visibility', () => {
  it('round-trips through serialize and parse', () => {
    const text = serializeSession({ ...base(), overlayVisibility: { contours: false, 'flow-drainage': true } });
    expect(parseSession(text).overlayVisibility).toEqual({ contours: false, 'flow-drainage': true });
  });

  it('an older session without the field loads with none, and writes none', () => {
    const text = serializeSession(base());
    expect(JSON.parse(text).overlayVisibility).toBeUndefined();
    expect(parseSession(text).overlayVisibility).toBeUndefined();
  });

  it('drops malformed entries', () => {
    const doc = JSON.parse(serializeSession(base()));
    doc.overlayVisibility = { contours: 'yes', 'Bad Id!': true, 'terrain-access-map': false };
    expect(parseSession(JSON.stringify(doc)).overlayVisibility).toEqual({ 'terrain-access-map': false });
    doc.overlayVisibility = [true];
    expect(parseSession(JSON.stringify(doc)).overlayVisibility).toBeUndefined();
  });

  it('a reopened session hides the overlay the user left hidden once it is generated', () => {
    const reg = createOverlayRegistry();
    const state = { available: false, visible: true };
    reg.register({ id: 'contours', label: 'Contours', isAvailable: () => state.available, get: () => state.visible, set: (v) => { state.visible = v; } });
    state.available = true;
    state.visible = false;
    const saved = parseSession(serializeSession({ ...base(), overlayVisibility: reg.snapshot() }));

    // Reopen: a fresh app, the analysis rerun draws contours visible by default.
    const reg2 = createOverlayRegistry();
    const s2 = { available: false, visible: true };
    reg2.register({ id: 'contours', label: 'Contours', isAvailable: () => s2.available, get: () => s2.visible, set: (v) => { s2.visible = v; } });
    reg2.restore(saved.overlayVisibility);
    s2.available = true;
    reg2.changed();
    expect(s2.visible).toBe(false);
  });
});
