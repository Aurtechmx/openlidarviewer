/**
 * analysePanelIdleReset.test.ts — what the panel says and offers with no result.
 *
 * `update(null)` shows the status line again but never rewrote it, so it
 * surfaced whatever the last run left there. After any analysis that text is
 * "Analysing…", written by `setBusy(true)` and never cleared by `setBusy(false)`.
 * Closing a scan therefore left a panel with no scan reading "Analysing…".
 *
 * The Run button had the same gap from the other side. `setBusy` is the only
 * writer of `disabled` in the tree, so a run that never reached its release left
 * the control dead with nothing downstream able to revive it, a scan close
 * included.
 *
 * Driven in the node environment through the same DOM stub the other
 * AnalysePanel tests use.
 */

import { describe, it, expect, beforeAll } from 'vitest';

import { FakeEl, installAnalysePanelDom } from './helpers/analysePanelDom';

beforeAll(() => {
  installAnalysePanelDom({});
});

/** The panel plus handles on the two elements these tests are about. */
async function freshPanel() {
  const { AnalysePanel } = await import('../src/ui/AnalysePanel');
  const panel = new AnalysePanel({});
  const root = panel.element as unknown as FakeEl;
  const status = root.findByClass('olv-analyse-status')[0];
  const runBtn = root.findByClass('olv-analyse-run')[0] ?? root
    .findByClass('olv-btn')
    .find((b) => b.tagName === 'button');
  return { panel, root, status, runBtn };
}

describe('the Analyse panel returns to rest when its result is cleared', () => {
  it('starts with the prompt that tells the user what to load', async () => {
    const { status } = await freshPanel();
    expect(status).toBeDefined();
    expect(status.ownText).toMatch(/Load a LAS, LAZ, COPC, or EPT dataset/);
  });

  it('puts the prompt back after a busy run is cleared', async () => {
    const { panel, status } = await freshPanel();
    panel.setBusy(true);
    expect(status.ownText).toBe('Analysing…');

    panel.update(null);
    // The pre-fix panel showed the status again without rewriting it, so this
    // read "Analysing…" on a panel with no scan.
    expect(status.ownText).toMatch(/Load a LAS, LAZ, COPC, or EPT dataset/);
    expect(status.ownText).not.toContain('Analysing');
  });

  it('re-enables the Run button when the result is cleared', async () => {
    const { panel, runBtn } = await freshPanel();
    expect(runBtn).toBeDefined();
    panel.setBusy(true);
    expect(runBtn!.disabled).toBe(true);

    panel.update(null);
    expect(runBtn!.disabled).toBe(false);
  });

  it('keeps setBusy authoritative while a run is actually in flight', async () => {
    // `update(null)` releasing the button must not mean anything else can. A
    // fresh busy claim after the clear still disables it.
    const { panel, runBtn } = await freshPanel();
    panel.update(null);
    panel.setBusy(true);
    expect(runBtn!.disabled).toBe(true);
    panel.setBusy(false);
    expect(runBtn!.disabled).toBe(false);
  });
});
