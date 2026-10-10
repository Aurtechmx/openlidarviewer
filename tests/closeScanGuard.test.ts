import { describe, it, expect, vi } from 'vitest';
import {
  createCloseScanGuard, describeDiscardableWork, hasDiscardableWork,
  type DiscardableWork, type CloseScanGuardDeps,
} from '../src/app/closeScanGuard';
import type { ConfirmChoice, ConfirmOptions } from '../src/ui/Modal';

const NONE: DiscardableWork = { measurements: 0, annotations: 0, views: 0, classEdits: false, results: 0, pendingRecovery: false };

function setup(work: Partial<DiscardableWork>, choice: ConfirmChoice = 'cancel', withSave = true) {
  const close = vi.fn();
  const saveSession = vi.fn(async () => true);
  const onSaveFailed = vi.fn();
  const confirm = vi.fn(async (_o: ConfirmOptions) => choice);
  const deps: CloseScanGuardDeps = { work: () => ({ ...NONE, ...work }), close, confirm, onSaveFailed, ...(withSave ? { saveSession } : {}) };
  return { guard: createCloseScanGuard(deps), close, saveSession, confirm, onSaveFailed };
}

describe('close scan guard', () => {
  it('closes without a dialog when nothing would be lost', async () => {
    const t = setup({});
    expect(await t.guard()).toBe(true);
    expect(t.confirm).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<DiscardableWork>]>([
    ['measurements', { measurements: 2 }],
    ['annotations', { annotations: 1 }],
    ['saved views', { views: 3 }],
    ['class edits', { classEdits: true }],
    ['ready results', { results: 1 }],
    ['a pending recovery journal', { pendingRecovery: true }],
  ])('asks first for %s', async (_n, work) => {
    const t = setup(work);
    expect(hasDiscardableWork({ ...NONE, ...work })).toBe(true);
    await t.guard();
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.close).not.toHaveBeenCalled();
  });

  it('leaves everything untouched on cancel', async () => {
    const t = setup({ measurements: 1 }, 'cancel');
    expect(await t.guard()).toBe(false);
    expect(t.close).not.toHaveBeenCalled();
    expect(t.saveSession).not.toHaveBeenCalled();
  });

  it('closes on confirm without saving', async () => {
    const t = setup({ annotations: 1 }, 'confirm');
    expect(await t.guard()).toBe(true);
    expect(t.saveSession).not.toHaveBeenCalled();
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it('saves the session, then closes, on the alternate choice', async () => {
    const order: string[] = [];
    const t = setup({ measurements: 1 }, 'alternate');
    t.saveSession.mockImplementation(async () => { order.push('save'); return true; });
    t.close.mockImplementation(() => { order.push('close'); });
    expect(await t.guard()).toBe(true);
    expect(order).toEqual(['save', 'close']);
  });

  it('keeps the scan open and says so when the save throws', async () => {
    const t = setup({ measurements: 1 }, 'alternate');
    t.saveSession.mockRejectedValue(new Error('disk'));
    expect(await t.guard()).toBe(false);
    expect(t.close).not.toHaveBeenCalled();
    expect(t.onSaveFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps the scan open and says so when the save is refused without writing', async () => {
    const t = setup({ measurements: 1 }, 'alternate');
    t.saveSession.mockResolvedValue(false);
    expect(await t.guard()).toBe(false);
    expect(t.close).not.toHaveBeenCalled();
    expect(t.onSaveFailed).toHaveBeenCalledTimes(1);
  });

  it('offers no save when class edits are the only work, and says the session does not store them', async () => {
    const t = setup({ classEdits: true });
    await t.guard();
    const o = t.confirm.mock.calls[0]![0];
    expect(o.alternateLabel).toBeUndefined();
    expect(o.message).toContain('does not store class edits');
    expect(o.message).not.toContain('Save the session first');
  });

  it('says results can be recomputed and offers no save when results are the only work', async () => {
    const t = setup({ results: 2 });
    await t.guard();
    const o = t.confirm.mock.calls[0]![0];
    expect(o.alternateLabel).toBeUndefined();
    expect(o.message).toContain('recomputed');
    expect(o.message).not.toContain('measurements, annotations and views');
  });

  it('offers Cancel, the alternate and the confirm label, and states what is lost', async () => {
    const t = setup({ measurements: 2, annotations: 1, classEdits: true });
    await t.guard();
    const o = t.confirm.mock.calls[0]![0];
    expect(o.cancelLabel).toBe('Cancel');
    expect(o.alternateLabel).toBe('Save session first');
    expect(o.confirmLabel).toBe('Close without saving');
    expect(o.message).toContain('2 measurements, 1 annotation, class edits that differ from the file');
  });

  it('omits the save choice when there is no save action', async () => {
    const t = setup({ measurements: 1 }, 'cancel', false);
    await t.guard();
    expect(t.confirm.mock.calls[0]![0].alternateLabel).toBeUndefined();
  });

  it('joins a second request made while the dialog is open', async () => {
    const t = setup({ measurements: 1 }, 'confirm');
    const [a, b] = await Promise.all([t.guard(), t.guard()]);
    expect([a, b]).toEqual([true, true]);
    expect(t.confirm).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledTimes(1);
  });

  it('describes a recovery-only journal', () => {
    expect(describeDiscardableWork({ ...NONE, pendingRecovery: true })).toBe('work saved for recovery in this browser');
  });
});
