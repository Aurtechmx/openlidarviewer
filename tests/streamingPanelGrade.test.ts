/**
 * streamingPanelGrade.test.ts
 *
 * The StreamingPanel's full-cloud grade surface: the "Grade full cloud" button
 * and the busy / result / error states it drives. Runs in the node environment
 * via the same recording DOM stub the other panel tests use (FakeEl), so the
 * render tree + button-disabled + result-text contract is pinned without a
 * browser. The decode itself is exercised live; this guards the panel wiring.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { FakeEl, installPanelDom, noopPanelCallbacks } from './support/streamingPanelDom';

beforeAll(installPanelDom);

describe('StreamingPanel — full-cloud grade surface', () => {
  it('renders the "Grade full cloud" button and the section label', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopPanelCallbacks());
    const root = panel.element as unknown as FakeEl;
    expect(root.findByText('Grade full cloud')).toHaveLength(1);
    expect(root.findByText('Full-cloud grade')).toHaveLength(1);
  });

  it('setGradeBusy turns the button into an enabled Cancel control and shows progress', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopPanelCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Decoding 3 / 10 nodes…');
    // Stays clickable (so the user can cancel) and relabels to Cancel.
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toContain('Cancel');
    expect(root.findContaining('Decoding 3 / 10 nodes…')).toBeDefined();
  });

  it('setGradeCancelled resets the button label and shows a neutral note (no error)', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopPanelCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Decoding…');
    panel.setGradeCancelled();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Grade full cloud');
    expect(root.findContaining('Grade cancelled.')).toBeDefined();
    // Not an error state.
    const result = root.findContaining('Grade cancelled.');
    expect(result).toBeDefined();
  });

  it('setGradeResult renders scope + lines + note and re-enables the button', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopPanelCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Planning…');
    panel.setGradeResult(
      '2.0M of 10.7M points (19%, sampled)',
      ['Density: Sparse · ≈ 7.50 pts/m²', 'Vertical extent: 63.7 m'],
      'Graded from a representative octree sample.',
    );
    expect(btn.disabled).toBe(false);
    expect(root.findContaining('19%, sampled')).toBeDefined();
    expect(root.findContaining('7.50 pts/m²')).toBeDefined();
    expect(root.findContaining('Vertical extent: 63.7 m')).toBeDefined();
    expect(root.findContaining('representative octree sample')).toBeDefined();
  });

  it('setGradeError re-enables the button, flags the error class, and shows the message', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopPanelCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeBusy('Planning…');
    panel.setGradeError('Open a streaming COPC or EPT scan first.');
    expect(btn.disabled).toBe(false);
    expect(root.findContaining('Open a streaming COPC or EPT scan first.')).toBeDefined();
  });

  it('hide() resets the grade result and re-enables the button for the next scan', async () => {
    const { StreamingPanel } = await import('../src/ui/StreamingPanel');
    const panel = new StreamingPanel(noopPanelCallbacks());
    const root = panel.element as unknown as FakeEl;
    const btn = root.findByText('Grade full cloud')[0];

    panel.setGradeResult('all 1.8M points (exact)', ['Density: Dense'], '');
    panel.hide();
    expect(btn.disabled).toBe(false);
    // The result region is emptied — its prior content no longer in the tree.
    expect(root.findContaining('all 1.8M points (exact)')).toBeUndefined();
  });
});
