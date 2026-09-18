/**
 * disposableGroup.test.ts — the teardown group must release everything once.
 */

import { describe, it, expect, vi } from 'vitest';
import { DisposableGroup } from '../src/disposableGroup';

describe('DisposableGroup', () => {
  it('runs every teardown on dispose', () => {
    const g = new DisposableGroup();
    const a = vi.fn();
    const b = vi.fn();
    g.add(a);
    g.add(b);
    expect(g.size).toBe(2);
    g.dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(g.size).toBe(0);
    expect(g.disposed).toBe(true);
  });

  it('is idempotent', () => {
    const g = new DisposableGroup();
    const a = vi.fn();
    g.add(a);
    g.dispose();
    g.dispose();
    g.dispose();
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('runs teardowns most recent first', () => {
    const order: number[] = [];
    const g = new DisposableGroup();
    g.add(() => order.push(1));
    g.add(() => order.push(2));
    g.dispose();
    expect(order).toEqual([2, 1]);
  });

  it('runs a late registration at once rather than retaining it', () => {
    const g = new DisposableGroup();
    g.dispose();
    const late = vi.fn();
    g.add(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(g.size).toBe(0);
  });

  it('removes a listener it added', () => {
    const target = new EventTarget();
    const handler = vi.fn();
    const g = new DisposableGroup();
    g.addListener(target, 'ping', handler);
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
    g.dispose();
    target.dispatchEvent(new Event('ping'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not strand later teardowns when one throws', () => {
    const g = new DisposableGroup();
    const after = vi.fn();
    g.add(after);
    g.add(() => {
      throw new Error('boom');
    });
    expect(() => g.dispose()).toThrow('boom');
    expect(after).toHaveBeenCalledTimes(1);
    expect(g.disposed).toBe(true);
  });
});
