/**
 * panelViewStatus.test.ts
 *
 * `StreamingPanel.setViewStatus` renders the current-view model and nothing
 * else decides the bar. The guard that matters is reversibility: the old panel
 * latched a terminal 100% on the phase string "Streaming ready" and early-
 * returned from every later update, so a camera move into unloaded terrain
 * still read complete. Ready must now be revocable by the next snapshot.
 *
 * Runs in the node environment on the same recording DOM stub the other panel
 * tests use.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type { StreamingViewStatus } from '../src/ui/streamingViewStatus';
import { installFakeDom, byClass, findContaining, type FakeEl } from './support/measurePanelDom';

beforeAll(installFakeDom);

function noopCallbacks() {
  return {
    onColorMode() {}, onQuality() {}, onPauseToggle() {}, onClearCache() {},
    onGradeFullCloud() {}, onCancelGrade() {},
  };
}

function model(over: Partial<StreamingViewStatus>): StreamingViewStatus {
  return {
    state: 'loading',
    headline: 'Loading current view…',
    fraction: 0.5,
    determinate: true,
    detail: '5 / 10 requested nodes resident',
    tone: 'progress',
    ...over,
  };
}

async function makePanel() {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const panel = new StreamingPanel(noopCallbacks());
  return { panel, root: panel.element as unknown as FakeEl };
}

describe('StreamingPanel — current-view readiness line', () => {
  it('renders the headline, the detail and a determinate fill', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(model({}));
    expect(findContaining(root, 'Loading current view…')).toBeDefined();
    expect(findContaining(root, '5 / 10 requested nodes resident')).toBeDefined();
    expect(byClass(root, 'olv-stream-prog-fill')?.style.width).toBe('50%');
    expect(byClass(root, 'olv-stream-prog-track')?.getAttribute('aria-valuenow')).toBe('50');
  });

  it('shows no percentage at all when the view is indeterminate', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(
      model({ state: 'unknown', headline: 'Establishing current view…', fraction: null, determinate: false, detail: '' }),
    );
    const track = byClass(root, 'olv-stream-prog-track');
    expect(track?.classList.contains('olv-stream-prog-shimmer')).toBe(true);
    // getAttribute follows DOM semantics: a removed attribute reads null.
    expect(track?.getAttribute('aria-valuenow')).toBeNull();
  });

  it('revokes ready when the next snapshot reports a new wanted set', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(
      model({ state: 'settled', headline: 'Current view ready', fraction: 1, detail: '20 / 20 requested nodes resident', tone: 'ready' }),
    );
    expect(byClass(root, 'olv-stream-prog-fill')?.style.width).toBe('100%');

    // Camera moved: 50 wanted, 20 resident. Nothing may hold the bar at 100%.
    panel.setViewStatus(model({ fraction: 0.4, detail: '20 / 50 requested nodes resident' }));
    expect(byClass(root, 'olv-stream-prog-fill')?.style.width).toBe('40%');
    expect(findContaining(root, 'Current view ready')).toBeUndefined();
    expect(findContaining(root, '20 / 50 requested nodes resident')).toBeDefined();
  });

  it('marks a view holding failed nodes without ever saying ready', async () => {
    const { panel, root } = await makePanel();
    panel.setViewStatus(
      model({
        state: 'incomplete',
        headline: 'Current view incomplete — 2 requested nodes could not load',
        fraction: 0.9,
        detail: '18 / 20 requested nodes resident',
        tone: 'warn',
      }),
    );
    expect(findContaining(root, 'Current view incomplete — 2 requested nodes could not load')).toBeDefined();
    expect(findContaining(root, 'Current view ready')).toBeUndefined();
    expect(byClass(root, 'olv-stream-prog-fill')?.style.width).toBe('90%');
  });

  it('reports whether the user has paused streaming', async () => {
    const { panel } = await makePanel();
    expect(panel.paused).toBe(false);
  });
});
