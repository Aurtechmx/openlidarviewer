import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFile, warmParseWorker, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import { FakeParseWorker } from './support/fakeParseWorker';

/**
 * The idle pre-warm starts the shared parse worker before the first open, so
 * the first file does not wait for the worker script. The warmed worker is
 * the one the first load uses: one worker, created once.
 */

afterEach(() => { __setParseWorkerFactoryForTests(undefined); });

describe('warmParseWorker', () => {
  it('creates the shared worker once, posts nothing, and the first load reuses it', async () => {
    const made: FakeParseWorker[] = [];
    __setParseWorkerFactoryForTests(() => {
      const w = new FakeParseWorker();
      made.push(w);
      return w as unknown as Worker;
    });
    warmParseWorker();
    warmParseWorker();
    expect(made).toHaveLength(1);
    expect(made[0]!.posted).toHaveLength(0);

    const b = readFileSync(resolve(__dirname, 'fixtures', 'multichunk.laz'));
    const result = await loadFile(new File([b], 'm.laz'));
    expect(result.cloud.name).toBe('m.laz');
    expect(made).toHaveLength(1);
    expect(made[0]!.posted).toHaveLength(1);
  });
});
