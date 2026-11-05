/** workflowConfigPanelConflict.test.ts: the settings refuse a key that could never fire. */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { installLiveFakeDom } from './helpers/liveFakeDom';

beforeAll(() => { installLiveFakeDom(); vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() }); });
interface Internals { _beginShortcutCapture(): void; _onShortcutKey(e: unknown): void; _capturingShortcut: boolean; _shortcutNote: { textContent: string; classList: { contains(c: string): boolean } }; config?: unknown; _config: { shortcut: string } }
const key = (k: string, shift = false) => ({ key: k, code: '', ctrlKey: true, metaKey: false, altKey: false, shiftKey: shift, preventDefault: vi.fn(), stopPropagation: vi.fn() });

async function panel(conflict: (e: unknown) => string | null) {
  const { WorkflowConfigPanel } = await import('../src/ui/WorkflowConfigPanel');
  return new WorkflowConfigPanel({ chordConflict: conflict }) as unknown as Internals;
}
describe('shortcut capture', () => {
  it('keeps the old key and stays capturing on a conflict, and says why', async () => {
    const p = await panel((e) => ((e as { key: string }).key === 'k' ? 'Open the command palette.' : null));
    const before = p._config.shortcut;
    p._beginShortcutCapture();
    p._onShortcutKey(key('k'));
    expect(p._config.shortcut).toBe(before);
    expect(p._capturingShortcut).toBe(true);
    expect(p._shortcutNote.textContent).toContain('Open the command palette. Choose another key.');
    expect(p._shortcutNote.classList.contains('olv-hidden')).toBe(false);
  });
  it('accepts a free key and clears the message', async () => {
    const p = await panel((e) => ((e as { key: string }).key === 'k' ? 'x' : null));
    p._beginShortcutCapture();
    p._onShortcutKey(key('k'));
    p._onShortcutKey(key('y', true));
    expect(p._config.shortcut).toBe('mod+shift+y');
    expect(p._capturingShortcut).toBe(false);
    expect(p._shortcutNote.classList.contains('olv-hidden')).toBe(true);
  });
});
