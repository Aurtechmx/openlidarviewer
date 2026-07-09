/**
 * buildIdentity.test.ts — the pure string helpers over the build-time identity.
 *
 * These assert the honesty behaviour: a real commit is shown, a dirty tree is
 * flagged, and the `'unknown'` fallback (git-less tarball build) degrades to a
 * plain version rather than a fabricated hash. The `BUILD_IDENTITY` constant
 * itself is stamped by the vitest `define` (a fixed TEST_BUILD_IDENTITY), so we
 * exercise the helpers over explicit inputs, not the ambient one.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILD_IDENTITY,
  buildIdentityLabel,
  buildIdentityProvenance,
  type BuildIdentity,
} from '../src/build/buildIdentity';

const base: BuildIdentity = {
  version: '0.5.8',
  commit: 'a1b2c3d',
  dirty: false,
  builtAt: '2026-07-08T18:22:00.000Z',
  node: 'v22.22.3',
  channel: 'live',
};

describe('buildIdentityLabel', () => {
  it('shows version + short commit for a clean build', () => {
    expect(buildIdentityLabel(base)).toBe('0.5.8 (a1b2c3d)');
  });

  it('flags a dirty working tree', () => {
    expect(buildIdentityLabel({ ...base, dirty: true })).toBe('0.5.8 (a1b2c3d+dirty)');
  });

  it('never fabricates a hash when the commit is unknown', () => {
    expect(buildIdentityLabel({ ...base, commit: 'unknown' })).toBe('0.5.8');
  });

  it('still reports dirtiness when the commit is unknown', () => {
    expect(buildIdentityLabel({ ...base, commit: 'unknown', dirty: true })).toBe('0.5.8 (dirty)');
  });
});

describe('buildIdentityProvenance', () => {
  it('is a single line with label, channel and build time', () => {
    expect(buildIdentityProvenance(base)).toBe(
      '0.5.8 (a1b2c3d) · live · built 2026-07-08T18:22:00.000Z',
    );
  });
});

describe('BUILD_IDENTITY (the stamped constant)', () => {
  it('is present and structurally complete under the test define', () => {
    expect(typeof BUILD_IDENTITY.version).toBe('string');
    expect(typeof BUILD_IDENTITY.commit).toBe('string');
    expect(typeof BUILD_IDENTITY.dirty).toBe('boolean');
    expect(typeof BUILD_IDENTITY.builtAt).toBe('string');
    expect(typeof BUILD_IDENTITY.channel).toBe('string');
  });
});
