/**
 * serialGate.test.ts — the FIFO mutex that serialises shared-parse-worker use.
 * Guards the loadFile concurrency fix: overlapping acquirers must run strictly
 * one-at-a-time, in call order, and a throw between acquire/release must not
 * wedge the queue.
 */

import { describe, it, expect } from 'vitest';
import { createSerialGate } from '../src/io/serialGate';

describe('createSerialGate', () => {
  it('runs overlapping critical sections one-at-a-time, in call order', async () => {
    const gate = createSerialGate();
    const log: string[] = [];

    const section = async (name: string) => {
      const release = await gate.acquire();
      try {
        log.push(`${name}:enter`);
        await Promise.resolve(); // yield — a non-serialised gate would interleave here
        await Promise.resolve();
        log.push(`${name}:exit`);
      } finally {
        release();
      }
    };

    // Start three overlapping sections; they must not interleave.
    await Promise.all([section('A'), section('B'), section('C')]);

    expect(log).toEqual([
      'A:enter', 'A:exit',
      'B:enter', 'B:exit',
      'C:enter', 'C:exit',
    ]);
  });

  it('a throwing holder still releases the gate for the next caller', async () => {
    const gate = createSerialGate();
    const order: string[] = [];

    const first = (async () => {
      const release = await gate.acquire();
      try {
        order.push('first');
        throw new Error('boom');
      } finally {
        release();
      }
    })();

    await expect(first).rejects.toThrow('boom');

    const release = await gate.acquire(); // must not hang
    order.push('second');
    release();

    expect(order).toEqual(['first', 'second']);
  });

  it('release is idempotent (double-release does not corrupt the queue)', async () => {
    const gate = createSerialGate();
    const release = await gate.acquire();
    release();
    release(); // no-op

    const r2 = await gate.acquire(); // still serialises correctly
    expect(typeof r2).toBe('function');
    r2();
  });
});
