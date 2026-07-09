/**
 * methodRegistry.test.ts — invariants of the scientific method catalogue.
 *
 * Guards the properties provenance relies on: ids are well-formed and match
 * their keys, versions are positive integers, every entry carries a citation,
 * and the lookup / tag helpers behave (including refusing an unknown id, so a
 * record can never reference a method the registry does not define).
 */
import { describe, it, expect } from 'vitest';
import {
  METHOD_REGISTRY,
  method,
  isMethodId,
  methodRef,
  methodTag,
} from '../src/science/methodRegistry';

describe('METHOD_REGISTRY invariants', () => {
  it('every key equals its entry id and is namespaced olv.<area>.<method>', () => {
    for (const [key, entry] of Object.entries(METHOD_REGISTRY)) {
      expect(entry.id).toBe(key);
      expect(key).toMatch(/^olv\.[a-z]+\.[a-z0-9-]+$/);
    }
  });

  it('every version is a positive integer', () => {
    for (const entry of Object.values(METHOD_REGISTRY)) {
      expect(Number.isInteger(entry.version)).toBe(true);
      expect(entry.version).toBeGreaterThanOrEqual(1);
    }
  });

  it('every entry carries a non-empty name, summary and citation', () => {
    for (const entry of Object.values(METHOD_REGISTRY)) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(entry.citation.length).toBeGreaterThan(0);
    }
  });
});

describe('lookup + tag helpers', () => {
  it('method() returns the entry or null', () => {
    expect(method('olv.terrain.vrm')?.name).toMatch(/Ruggedness/);
    expect(method('olv.does.not-exist')).toBeNull();
  });

  it('isMethodId reflects membership', () => {
    expect(isMethodId('olv.validation.spatial-block')).toBe(true);
    expect(isMethodId('nope')).toBe(false);
  });

  it('methodRef returns id+version and refuses an unknown id', () => {
    expect(methodRef('olv.validation.spatial-block')).toEqual({
      id: 'olv.validation.spatial-block',
      version: 2,
    });
    expect(() => methodRef('olv.ghost')).toThrow(/Unknown method id/);
  });

  it('methodTag renders the stable id@version form', () => {
    expect(methodTag(methodRef('olv.validation.spatial-block'))).toBe(
      'olv.validation.spatial-block@2',
    );
  });
});
