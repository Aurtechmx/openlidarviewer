/**
 * loadScope.test.ts: the loading-scope words come from the plan's mode, and a
 * count the header does not state stays unstated.
 */

import { describe, it, expect } from 'vitest';
import {
  loadScopeForMode,
  loadScopeLabel,
  loadContextFacts,
  streamingContextFacts,
  knownPointCount,
} from '../src/io/loadScope';
import { buildPreloadSummary } from '../src/io/preloadSummary';
import type { SourceMetadata } from '../src/io/PointCloudSource';
import type { LoadMode } from '../src/io/loadPlan';

describe('loading scope from the plan mode', () => {
  const cases: Array<[LoadMode, string]> = [
    ['stride', 'Sampled load'],
    ['voxel', 'Thinned for display'],
    ['all', 'Standard load'],
  ];
  it.each(cases)('%s reads as "%s"', (mode, label) => {
    expect(loadScopeLabel(loadScopeForMode(mode))).toBe(label);
  });

  it('a streaming route reads as "Streaming"', () => {
    expect(loadScopeLabel('streaming')).toBe('Streaming');
    expect(streamingContextFacts('copc').facts).toEqual(['COPC', 'Streaming']);
    expect(streamingContextFacts(undefined).facts).toEqual(['Streaming']);
  });

  it('never claims a complete dataset', () => {
    for (const scope of ['standard', 'thinned', 'sampled', 'streaming'] as const) {
      expect(loadScopeLabel(scope).toLowerCase()).not.toContain('complete');
    }
  });
});

describe('counts before decoding', () => {
  it('keeps an unknown, zero or non-finite count unknown', () => {
    expect(knownPointCount(undefined)).toBeUndefined();
    expect(knownPointCount(0)).toBeUndefined();
    expect(knownPointCount(-5)).toBeUndefined();
    expect(knownPointCount(Number.NaN)).toBeUndefined();
    expect(knownPointCount(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(knownPointCount(1234)).toBe(1234);
  });

  it('omits the count from the facts and the summary when the header states none', () => {
    const ply: SourceMetadata = { format: 'ply', label: 'PLY cloud', byteSize: 2048 };
    expect(loadContextFacts(ply).facts).toEqual(['PLY']);
    const zero: SourceMetadata = { format: 'las', label: 'LAS scan', byteSize: 4096, estimatedPointCount: 0, loadScope: 'standard' };
    expect(loadContextFacts(zero).facts).toEqual(['LAS', 'Standard load']);
    expect(buildPreloadSummary(zero).join('\n')).not.toMatch(/\b0 source points/);
  });

  it('states a header count as the source count, not an on-screen count', () => {
    const e57: SourceMetadata = {
      format: 'e57',
      label: 'E57 scan',
      byteSize: 600 * 1024 * 1024,
      estimatedPointCount: 26_900_000,
      loadScope: 'sampled',
      warning: 'Large E57 scan: read as a SAMPLE.',
    };
    const facts = loadContextFacts(e57);
    expect(facts.facts).toEqual(['E57', 'Sampled load', '26.9M source points']);
    expect(facts.note).toBe('Large E57 scan: read as a SAMPLE.');
    expect(facts.announce).toContain('Source records are sampled.');
  });
});

describe('the preload summary', () => {
  it('names the scope from the plan rather than the older summary string', () => {
    const meta: SourceMetadata = {
      format: 'las',
      label: 'LAS scan',
      byteSize: 48 * 1024 * 1024,
      estimatedPointCount: 4_200_000,
      loadModeSummary: 'Large-file optimization enabled',
      loadScope: 'thinned',
    };
    const lines = buildPreloadSummary(meta);
    expect(lines).toContain('Thinned for display');
    expect(lines).not.toContain('Large-file optimization enabled');
  });
});
