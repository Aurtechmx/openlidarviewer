import { describe, it, expect } from 'vitest';
import { settle } from '../src/app/settle';

describe('settle', () => {
  it('runs the function at once and resolves with its value', async () => {
    let ran = false;
    const p = settle(() => { ran = true; return 3; });
    expect(ran).toBe(true);
    await expect(p).resolves.toBe(3);
  });

  it('turns a throw into a rejection', async () => {
    let p: Promise<number> | undefined;
    expect(() => { p = settle<number>(() => { throw new Error('boom'); }); }).not.toThrow();
    await expect(p).rejects.toThrow('boom');
  });

  it('wraps a thrown non-Error in an Error', async () => {
    await expect(settle(() => { throw 'text'; })).rejects.toThrow('text');
  });
});
