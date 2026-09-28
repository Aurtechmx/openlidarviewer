/**
 * streamingPanelBusyScan.test.ts: the busy scan in the streaming panel's
 * phase line. It stands in front of the opening phases, its trail follows the
 * resident share of the requested nodes, and it goes once the first view is
 * settled (or the view stops being an opening: incomplete, paused).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Node0, installBusyScanDom } from './helpers/busyScanDom';
import { streamingPanelCallbacks } from './helpers/streamingPanelFixture';
import type { StreamingViewStatus } from '../src/ui/streamingViewStatus';

beforeAll(() => installBusyScanDom());

const view = (state: StreamingViewStatus['state'], fraction: number | null): StreamingViewStatus => ({
  state,
  headline: `View ${state}`,
  fraction,
  determinate: fraction != null,
  detail: '',
  tone: 'progress',
});

async function freshPanel() {
  const { StreamingPanel } = await import('../src/ui/StreamingPanel');
  const panel = new StreamingPanel(streamingPanelCallbacks());
  const root = panel.element as unknown as Node0;
  const phase = root.find('olv-streaming-phase')[0];
  const scan = () => phase.find('olv-busy-scan')[0];
  return { panel, phase, scan };
}

describe('streaming panel busy scan', () => {
  it('shows the scan in front of the opening phase text', async () => {
    const { panel, phase, scan } = await freshPanel();
    panel.setPhase('Loading metadata…');
    expect(scan()).toBeDefined();
    expect(scan().getAttribute('aria-hidden')).toBe('true');
    expect(phase.text).toContain('Loading metadata…');
  });

  it('grows the trail with the resident share while the first view loads', async () => {
    const { panel, scan } = await freshPanel();
    panel.setPhase('Streaming coarse geometry…');
    panel.setViewStatus(view('loading', 0.2));
    const a = Number(scan().style['--olv-bs-len']);
    panel.setViewStatus(view('loading', 0.7));
    const b = Number(scan().style['--olv-bs-len']);
    expect(b).toBeGreaterThan(a);
  });

  it('removes the scan once the first view is settled, and does not bring it back', async () => {
    const { panel, phase, scan } = await freshPanel();
    panel.setPhase('Streaming coarse geometry…');
    panel.setViewStatus(view('loading', 0.5));
    panel.setViewStatus(view('settled', 1));
    expect(scan()).toBeUndefined();
    expect(phase.text).toBe('View settled');
    panel.setViewStatus(view('loading', 0.3));
    expect(scan()).toBeUndefined();
  });

  it('removes the scan when the view is paused or incomplete', async () => {
    for (const state of ['paused', 'incomplete'] as const) {
      const { panel, scan } = await freshPanel();
      panel.setPhase('Streaming coarse geometry…');
      panel.setViewStatus(view(state, 0.4));
      expect(scan()).toBeUndefined();
    }
  });

  it('keeps the same scan in the line across status polls, changing only the text', async () => {
    const { panel, phase, scan } = await freshPanel();
    panel.setPhase('Streaming coarse geometry…');
    const first = scan();
    // Re-inserting the scan restarts its CSS animation, so the line must not
    // be rebuilt on each poll.
    let rebuilt = 0;
    const replace = phase.replaceChildren.bind(phase);
    phase.replaceChildren = (...kids) => { rebuilt++; replace(...kids); };
    panel.setViewStatus(view('loading', 0.2));
    panel.setViewStatus({ ...view('loading', 0.4), headline: 'Loading view' });
    expect(scan()).toBe(first);
    expect(rebuilt).toBe(0);
    expect(phase.find('olv-busy-scan')).toHaveLength(1);
    expect(phase.text).toContain('Loading view');
    expect(phase.text).not.toContain('Streaming coarse geometry…');
  });
});
