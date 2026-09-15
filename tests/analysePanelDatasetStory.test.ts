/**
 * analysePanelDatasetStory.test.ts
 *
 * The Dataset Story used to be reachable only through a command-palette modal,
 * so the fitness read that decides what a scan may be used for was invisible to
 * anyone who did not know the action existed. The Analyse panel now hosts it as
 * a collapsible section at the top of the panel.
 *
 * Pinned here: the host slot exists before any story is set, the card mounts
 * inside a disclosure rather than a modal, a second call replaces the card
 * instead of stacking one, and null clears the section entirely.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { installRecordingDom, RecordingEl } from './helpers/recordingDom';

beforeAll(installRecordingDom);

const { AnalysePanel } = await import('../src/ui/AnalysePanel');

/** A fresh panel and the recording root its tree was built into. */
function mountPanel(): { panel: InstanceType<typeof AnalysePanel>; root: RecordingEl } {
  const panel = new AnalysePanel({});
  return { panel, root: panel.element as unknown as RecordingEl };
}

/** A stand-in story card, so the test never depends on the real renderer. */
function card(text: string): HTMLElement {
  const node = new RecordingEl('aside');
  node.className = 'olv-story-card';
  node.textContent = text;
  return node as unknown as HTMLElement;
}

describe('the Analyse panel hosts the Dataset Story', () => {
  it('keeps an empty slot for it above the run control', () => {
    const { root } = mountPanel();
    const host = root.find('olv-analyse-story');
    expect(host).not.toBeNull();
    expect(host!.children).toHaveLength(0);
    const order = root.children.map((c) => c.className);
    expect(order.indexOf('olv-analyse-story')).toBeLessThan(
      order.findIndex((c) => c.includes('olv-analyse-run')),
    );
  });

  it('mounts the card in a disclosure, not a modal', () => {
    const { panel, root } = mountPanel();
    panel.setDatasetStory(card('Dataset Story'));
    const host = root.find('olv-analyse-story')!;
    expect(host.children).toHaveLength(1);
    expect(host.children[0].tagName).toBe('details');
    expect(host.children[0].open).toBe(false);
    expect(host.textContent).toContain('Dataset Story');
    expect(root.tags()).not.toContain('dialog');
  });

  it('replaces the card rather than stacking a second one', () => {
    const { panel, root } = mountPanel();
    panel.setDatasetStory(card('first'));
    panel.setDatasetStory(card('second'));
    const host = root.find('olv-analyse-story')!;
    expect(host.children).toHaveLength(1);
    expect(host.textContent).toContain('second');
    expect(host.textContent).not.toContain('first');
  });

  it('clears the section when there is no story to tell', () => {
    const { panel, root } = mountPanel();
    panel.setDatasetStory(card('first'));
    panel.setDatasetStory(null);
    expect(root.find('olv-analyse-story')!.children).toHaveLength(0);
  });
});
