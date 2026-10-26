/**
 * run-gdaldem-reference.mjs takes containerPinning from the environment record
 * the oracle image writes, and records a host run as not-executed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain .mjs script without type declarations
import { containerPinningFromEnvironment } from '../scripts/run-gdaldem-reference.mjs';

const write = (body: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'olv-env-')), 'env.json');
  writeFileSync(file, body, 'utf8');
  return file;
};

describe('containerPinningFromEnvironment', () => {
  it('copies the image record', () => {
    const file = write(JSON.stringify({ environment: { containerPinning: 'executed', containerPinningReason: 'inside the image' } }));
    expect(containerPinningFromEnvironment(file)).toEqual({ containerPinning: 'executed', containerPinningReason: 'inside the image' });
  });

  it('records not-executed with the true reason when there is no usable record', () => {
    for (const arg of [undefined, '/nonexistent/env.json', write('not json'), write('{"environment":{}}')]) {
      const r = containerPinningFromEnvironment(arg);
      expect(r.containerPinning).toBe('not-executed');
      expect(r.containerPinningReason).toMatch(/host PATH/);
      expect(r.containerPinningReason).not.toMatch(/Docker daemon/);
    }
  });
});
