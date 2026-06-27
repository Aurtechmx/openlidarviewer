import { describe, test, expect } from 'vitest';
import { ClassificationEpochs } from '../src/render/measure/classificationEpoch';

describe('ClassificationEpochs', () => {
  test('an unedited cloud is at epoch 0 and nothing stamped there is stale', () => {
    const e = new ClassificationEpochs();
    expect(e.current('a')).toBe(0);
    expect(e.isStale('a', 0)).toBe(false);
  });

  test('an edit bumps the epoch and staleness is per-cloud', () => {
    const e = new ClassificationEpochs();
    const stamp = e.current('a'); // result computed now
    expect(e.bump('a')).toBe(1); // user edits classification of cloud a
    expect(e.isStale('a', stamp)).toBe(true); // the old result is now stale
    expect(e.isStale('b', stamp)).toBe(false); // cloud b untouched
  });

  test('a result re-stamped after the edit reads fresh again', () => {
    const e = new ClassificationEpochs();
    e.bump('a');
    const fresh = e.current('a'); // recomputed at the new epoch
    expect(e.isStale('a', fresh)).toBe(false);
    e.bump('a'); // another edit
    expect(e.isStale('a', fresh)).toBe(true);
  });

  test('forget drops a cloud (and resets it to epoch 0)', () => {
    const e = new ClassificationEpochs();
    e.bump('a');
    e.bump('a');
    expect(e.current('a')).toBe(2);
    e.forget('a');
    expect(e.current('a')).toBe(0);
  });
});
