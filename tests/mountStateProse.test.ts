/**
 * mountStateProse.test.ts — lint:architecture-truth holds the mount-state prose
 * in STABILITY_POLICY to the MULTI_LAYER_MOUNT_ENABLED flag. The prose states
 * the state in words, and the v0.6.4 "mount is disabled" line outlived the
 * v0.6.5 flip with no check covering it. These tests pin the detector: it reads
 * the current state, ignores a historical clause, and matches across a wrap.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — plain .mjs lint script, no types
import { mountStateFromProse } from '../scripts/lint-architecture-truth.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('mountStateFromProse', () => {
  it('reads the shipped-enabled assertion, even wrapped across a line', () => {
    expect(mountStateFromProse('Multi-layer mounting\nshipped enabled in v0.6.5.')).toBe('enabled');
  });

  it('reads a disabled assertion', () => {
    expect(mountStateFromProse('Multi-layer mounting is disabled by default.')).toBe('disabled');
  });

  it('ignores a purely historical clause (no present-tense verb reachable)', () => {
    expect(mountStateFromProse('Multi-layer mounting was disabled before v0.6.5.')).toBeNull();
  });

  it('skips a historical sentence and reads a later present-tense one', () => {
    // The first sentence names mounting but has no present-tense verb, so the
    // match backtracks to the second, present-tense assertion.
    expect(
      mountStateFromProse(
        'Multi-layer mounting was disabled in v0.6.4. Multi-layer mounting now ships enabled.',
      ),
    ).toBe('enabled');
  });

  it('returns null when the document says nothing about mounting', () => {
    expect(mountStateFromProse('The session schema is at version 7.')).toBeNull();
  });

  it('agrees with the shipped policy document and the live flag', () => {
    const policy = readFileSync(resolve(ROOT, 'docs/project/STABILITY_POLICY.md'), 'utf8');
    const svc = readFileSync(resolve(ROOT, 'src/app/LayerService.ts'), 'utf8');
    const enabled = /MULTI_LAYER_MOUNT_ENABLED\s*=\s*true/.test(svc);
    const stated = mountStateFromProse(policy);
    expect(stated).not.toBeNull();
    expect(stated === 'enabled').toBe(enabled);
  });
});
