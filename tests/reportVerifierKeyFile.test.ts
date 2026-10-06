/**
 * reportVerifierKeyFile.test.ts
 *
 * The verifier's "Load key file" picker used to ignore a file over 4096 bytes
 * without saying so. It now names the problem, and the limit and the message
 * are exported so the rule is tested without a DOM.
 */
import { describe, it, expect } from 'vitest';
import { KEY_FILE_MAX_BYTES, KEY_FILE_TOO_LARGE, keyFileProblem } from '../src/ui/reportVerifier';

describe('keyFileProblem', () => {
  it('accepts a file up to the limit', () => {
    expect(keyFileProblem(0)).toBeNull();
    expect(keyFileProblem(300)).toBeNull();
    expect(keyFileProblem(KEY_FILE_MAX_BYTES)).toBeNull();
  });

  it('names a file over the limit, with the size in the message', () => {
    expect(keyFileProblem(KEY_FILE_MAX_BYTES + 1)).toBe(KEY_FILE_TOO_LARGE);
    expect(KEY_FILE_TOO_LARGE).toMatch(/too large \(over 4 KB\)/);
    expect(KEY_FILE_MAX_BYTES).toBe(4096);
  });
});
