import { describe, expect, it, vi } from 'vitest';

/**
 * A worker can evaluate src/io/loadErrors.ts twice (WebKit re-evaluates a
 * worker's entry chunk when a lazy chunk imports from it). An error built by
 * one copy must still be a LoadError to the other, or the worker drops its
 * category and report.
 */
describe('LoadError across two copies of its module', () => {
  it('is recognised by the other copy, with its category and report', async () => {
    const a = await import('../src/io/loadErrors');
    vi.resetModules();
    const b = await import('../src/io/loadErrors');
    expect(a.LoadError).not.toBe(b.LoadError);

    const err: unknown = new a.LoadError('unsupported-format', 'reason for the user', 'reason for the user');
    expect(err instanceof b.LoadError).toBe(true);
    expect((err as InstanceType<typeof b.LoadError>).category).toBe('unsupported-format');
    expect(b.describeLoadError(err)).toBe('reason for the user');
  });

  it('does not match a plain Error or a look-alike object', async () => {
    const { LoadError } = await import('../src/io/loadErrors');
    expect(new Error('x') instanceof LoadError).toBe(false);
    expect({ name: 'LoadError', category: 'malformed-file' } instanceof LoadError).toBe(false);
    expect((null as unknown as object) instanceof LoadError).toBe(false);
  });
});
