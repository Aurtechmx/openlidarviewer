/**
 * layerHealthCardEmptyState.test.ts
 *
 * INSPECT-INSP-9: LayerHealthCard built and mounted its own "no layers
 * loaded" placeholder block, but no code path ever revealed it — `update()`
 * only ever shows `root` itself when there are layers, and both `update([],
 * ...)` and `clear()` hide `root` wholesale rather than swapping to the
 * placeholder. The block was `display:none` in every reachable state, and
 * its own comment ("kept in the tree for assistive callers") overstated
 * what it did: nested inside an also-hidden root, toggling its own hidden
 * class could never have mattered to anyone.
 *
 * The block and its dead toggle path are removed rather than wired up: root
 * being hidden already communicates "nothing to show" (the panel disappears
 * like every other Inspector card with no data), so there was no missing
 * behaviour to add, only dead markup to drop.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { LayerHealthCard } from '../src/ui/LayerHealthCard';
import { FakeEl, installFakeDom } from './support/measurePanelDom';
import type { LayerHealthRow } from '../src/app/layerHealth';

beforeAll(() => {
  installFakeDom();
});

const ROW: LayerHealthRow = { label: 'CRS', value: 'EPSG:32613', status: 'ok' };

describe('LayerHealthCard — empty state', () => {
  it('mounts no "olv-layerhealth-empty" placeholder at all', () => {
    const card = new LayerHealthCard();
    const root = card.root as unknown as FakeEl;
    expect(root.querySelectorAll('.olv-layerhealth-empty')).toHaveLength(0);

    card.update([{ name: 'campus.laz', rows: [ROW] }], null);
    expect(root.querySelectorAll('.olv-layerhealth-empty')).toHaveLength(0);

    card.clear();
    expect(root.querySelectorAll('.olv-layerhealth-empty')).toHaveLength(0);
  });

  it('hides the whole card when there are no layers, and shows it once there are', () => {
    const card = new LayerHealthCard();
    const root = card.root as unknown as FakeEl;
    expect(root.classList.contains('olv-hidden')).toBe(true);

    card.update([{ name: 'campus.laz', rows: [ROW] }], null);
    expect(root.classList.contains('olv-hidden')).toBe(false);

    card.update([], null);
    expect(root.classList.contains('olv-hidden')).toBe(true);
  });

  it('clear() hides the card and drops its content', () => {
    const card = new LayerHealthCard();
    const root = card.root as unknown as FakeEl;
    card.update([{ name: 'campus.laz', rows: [ROW] }], null);
    expect(root.classList.contains('olv-hidden')).toBe(false);

    card.clear();
    expect(root.classList.contains('olv-hidden')).toBe(true);
  });
});
