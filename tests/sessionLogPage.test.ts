/**
 * sessionLogPage.test.ts
 *
 * The Session log page with a stub DOM: the table, the order toggle, the
 * dropped-entries row, Copy (done, refused, unavailable), both exports and
 * dispose. While the page is off screen it does no work, and once shown it
 * adds rows for new entries without rebuilding the ones it has. Each button's
 * accessible name is its visible text.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionLog } from '../src/app/sessionLog/sessionLog';
import { mountSessionLogPage } from '../src/app/sessionLog/sessionLogPage';
import { installSessionLogDom, SNode, uninstallSessionLogDom, type SDoc } from './helpers/sessionLogDom';

let doc: SDoc;
beforeEach(() => { doc = installSessionLogDom(); });
afterEach(() => { uninstallSessionLogDom(); vi.restoreAllMocks(); });

const NOW = Date.UTC(2026, 9, 1, 9, 30, 0);

function setup(opts: { clipboard?: Pick<Clipboard, 'writeText'> | null; cap?: number } = {}) {
  const log = createSessionLog({ cap: opts.cap ?? 2000, now: () => NOW });
  const mode = new SNode('div');
  const host = new SNode('section');
  mode.append(host);
  doc.body.append(mode);
  const queue: Array<() => void> = [];
  const page = mountSessionLogPage(host as unknown as HTMLElement, log, {
    version: '0.7.0',
    now: () => NOW,
    clipboard: opts.clipboard,
    schedule: (fn) => { queue.push(fn); },
  });
  const flush = (): void => { while (queue.length) queue.shift()!(); };
  const rows = (): SNode[] => host.querySelectorAll('.olv-sl-row');
  const btn = (text: string): SNode => host.querySelectorAll('button').find((b) => b.textContent === text)!;
  const status = (): string => host.querySelector('.olv-sl-status')!.textContent;
  return { log, host, mode, page, flush, rows, btn, status };
}

describe('session log page', () => {
  it('starts empty and lists entries newest first', () => {
    const s = setup();
    expect(s.host.querySelector('.olv-sl-empty')!.hidden).toBe(false);
    expect(s.btn('Copy as text').disabled).toBe(true);
    s.log.append({ kind: 'scan', text: 'Opened a.laz', scan: 'a.laz' });
    s.log.append({ kind: 'export', text: 'Exported a.csv', detail: 'type: CSV', scan: 'a.laz' });
    s.log.append({ kind: 'error', text: 'Could not read b.laz', status: 'failed', scan: null });
    s.flush();
    expect(s.rows().map((r) => r.querySelector('.olv-sl-text')!.textContent)).toEqual(['Could not read b.laz', 'Exported a.csv', 'Opened a.laz']);
    expect(s.rows()[0]!.querySelector('.olv-sl-meta')!.textContent).toBe('failed');
    expect(s.rows()[1]!.querySelector('.olv-sl-meta')!.textContent).toBe('a.laz · type: CSV');
    expect(s.host.querySelector('.olv-sl-caption')!.textContent).toBe('3 entries');
    expect(s.host.querySelector('.olv-sl-empty')!.hidden).toBe(true);
    expect(s.btn('Copy as text').disabled).toBe(false);
  });

  it('reverses the order and keeps the dropped-entries row at the old end', () => {
    const s = setup({ cap: 2 });
    for (const t of ['one', 'two', 'three']) s.log.append({ kind: 'command', text: t });
    s.flush();
    const labels = (): string[] => s.host.querySelector('tbody')!.children.map((r) => r.textContent);
    expect(labels()[2]).toBe('1 older entry dropped');
    s.btn('Newest first').click();
    expect(s.btn('Oldest first')).toBeTruthy();
    expect(labels()[0]).toBe('1 older entry dropped');
    expect(s.host.querySelector('.olv-sl-caption')!.textContent).toBe('2 entries, 1 older entry dropped');
  });

  it('does no work while off screen and catches up when shown', () => {
    const s = setup();
    s.log.append({ kind: 'command', text: 'first' });
    s.flush();
    s.mode.classList.add('olv-ws-off');
    for (let i = 0; i < 5; i++) s.log.append({ kind: 'command', text: `hidden ${i}` });
    s.flush();
    expect(s.rows()).toHaveLength(1);
    s.mode.classList.remove('olv-ws-off');
    s.page.refreshIfDirty();
    expect(s.rows()).toHaveLength(6);
  });

  it('adds rows for new entries without rebuilding the ones on screen, and drops rows past the cap', () => {
    const s = setup({ cap: 3 });
    s.log.append({ kind: 'command', text: 'a' });
    s.log.append({ kind: 'command', text: 'b' });
    s.flush();
    const before = s.rows();
    s.log.append({ kind: 'command', text: 'c' });
    s.flush();
    expect(s.rows().slice(1)).toEqual(before);
    s.log.append({ kind: 'command', text: 'd' });
    s.flush();
    expect(s.rows().map((r) => r.querySelector('.olv-sl-text')!.textContent)).toEqual(['d', 'c', 'b']);
    expect(s.rows()[2]).toBe(before[0]);
  });

  it('copies the log as dated text, and says so when the browser refuses or has no clipboard', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    const s = setup({ clipboard: { writeText } });
    s.log.append({ kind: 'command', text: 'Frame all' });
    s.flush();
    s.btn('Copy as text').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(writeText.mock.calls[0]![0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  Command  Frame all$/);
    expect(s.status()).toBe('Session log copied as text.');

    const refused = setup({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    refused.log.append({ kind: 'command', text: 'x' });
    refused.flush();
    refused.btn('Copy as text').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(refused.status()).toBe('The browser refused the copy. Use Export instead.');

    const none = setup({ clipboard: null });
    none.log.append({ kind: 'command', text: 'x' });
    none.flush();
    none.btn('Copy as text').click();
    expect(none.status()).toBe('Copy is not available in this browser. Use Export instead.');
  });

  it('exports JSON and CSV under dated file names', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const s = setup();
    s.log.append({ kind: 'command', text: 'Frame all' });
    s.flush();
    s.btn('Export JSON').click();
    s.btn('Export CSV').click();
    expect(doc.downloads.map((a) => a.download)).toEqual([expect.stringMatching(/^session-log-\d{8}-\d{4}\.json$/), expect.stringMatching(/^session-log-\d{8}-\d{4}\.csv$/)]);
    expect(doc.downloads.every((a) => !a.isConnected)).toBe(true);
    expect(s.status()).toBe('Session log exported as CSV.');
  });

  it('names each button by its visible text', () => {
    const s = setup();
    for (const b of s.host.querySelectorAll('button')) {
      const name = b.getAttribute('aria-label');
      expect(name === null || name.startsWith(b.textContent), `${b.textContent} / ${name}`).toBe(true);
    }
  });

  it('stops following the log once disposed', () => {
    const s = setup();
    s.page.dispose();
    s.log.append({ kind: 'command', text: 'late' });
    s.flush();
    expect(s.host.children).toHaveLength(0);
  });
});

describe('session log dialog', () => {
  const key = (k: string): void => {
    (globalThis as unknown as { window: SDoc }).window.fire('keydown', { key: k, preventDefault() {}, stopPropagation() {} });
  };

  it('shows the log in a labelled dialog that Escape and Close dismiss', async () => {
    const { openSessionLogDialog } = await import('../src/app/sessionLog/sessionLogPage');
    const log = createSessionLog();
    log.append({ kind: 'error', text: 'Could not read broken #1.laz', status: 'failed', scan: null });
    const first = openSessionLogDialog(log, { schedule: (fn) => fn() });
    const dialog = doc.body.querySelector('[role="dialog"]')!;
    const titleId = dialog.getAttribute('aria-labelledby')!;
    expect(dialog.querySelectorAll('h2').find((h) => h.id === titleId)?.textContent).toBe('Session log');
    expect(dialog.querySelectorAll('.olv-sl-row')).toHaveLength(1);
    key('Escape');
    expect(doc.body.querySelector('.olv-modal-backdrop')).toBeNull();
    first.close();

    openSessionLogDialog(log);
    doc.body.querySelector('.olv-sl-close')!.click();
    expect(doc.body.querySelector('.olv-modal-backdrop')).toBeNull();
  });

  it('joins the shared dialog stack, so the palette and the shortcut sheet wait', async () => {
    const { openSessionLogDialog } = await import('../src/app/sessionLog/sessionLogPage');
    const { dialogOpen } = await import('../src/ui/Modal');
    const d = openSessionLogDialog(createSessionLog());
    expect(dialogOpen()).toBe(true);
    d.close();
    expect(dialogOpen()).toBe(false);
  });

  it('opens one dialog at a time and focuses the open one', async () => {
    const { openSessionLogDialog } = await import('../src/app/sessionLog/sessionLogPage');
    const log = createSessionLog();
    const a = openSessionLogDialog(log);
    doc.activeElement = doc.body;
    const b = openSessionLogDialog(log);
    expect(doc.body.querySelectorAll('.olv-modal-backdrop')).toHaveLength(1);
    expect(doc.activeElement).toBe(doc.body.querySelector('.olv-sl-close'));
    b.close();
    a.close();
    expect(doc.body.querySelectorAll('.olv-modal-backdrop')).toHaveLength(0);
  });

  it('gives focus back to the opener, or to the first control of the app when the opener is gone', async () => {
    const { openSessionLogDialog } = await import('../src/app/sessionLog/sessionLogPage');
    const app = new SNode('div');
    app.id = 'app';
    const first = new SNode('button');
    const opener = new SNode('button');
    app.append(first, opener);
    doc.body.append(app);

    opener.focus();
    openSessionLogDialog(createSessionLog()).close();
    expect(doc.activeElement).toBe(opener);

    const gone = new SNode('input');
    doc.body.append(gone);
    gone.focus();
    const d = openSessionLogDialog(createSessionLog());
    gone.remove();
    d.close();
    expect(doc.activeElement).toBe(first);

    doc.activeElement = doc.body;
    openSessionLogDialog(createSessionLog()).close();
    expect(doc.activeElement).toBe(first);
  });

  it('skips hidden buttons when it gives focus to the app', async () => {
    const { openSessionLogDialog } = await import('../src/app/sessionLog/sessionLogPage');
    const app = new SNode('div');
    app.id = 'app';
    const hidden = new SNode('button');
    hidden.hidden = true;
    const panel = new SNode('div');
    panel.className = 'olv-hidden';
    const inPanel = new SNode('button');
    panel.append(inPanel);
    const shown = new SNode('button');
    app.append(hidden, panel, shown);
    doc.body.append(app);
    doc.activeElement = doc.body;
    openSessionLogDialog(createSessionLog()).close();
    expect(doc.activeElement).toBe(shown);
  });

  it('leaves the dialog stack even when the page fails to tear down', async () => {
    const { openSessionLogDialog } = await import('../src/app/sessionLog/sessionLogPage');
    const { dialogOpen } = await import('../src/ui/Modal');
    const log = createSessionLog();
    log.subscribe = () => () => { throw new Error('gone'); };
    const d = openSessionLogDialog(log);
    expect(() => d.close()).toThrow('gone');
    expect(dialogOpen()).toBe(false);
    expect(doc.body.querySelector('.olv-modal-backdrop')).toBeNull();
  });
});

describe('session log page, default repaint', () => {
  it('repaints a frame after an append when no scheduler is given', async () => {
    const log = createSessionLog();
    const host = new SNode('section');
    doc.body.append(host);
    mountSessionLogPage(host as unknown as HTMLElement, log);
    log.append({ kind: 'command', text: 'Frame all' });
    expect(host.querySelectorAll('.olv-sl-row')).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(host.querySelectorAll('.olv-sl-row')).toHaveLength(1);
  });
});
