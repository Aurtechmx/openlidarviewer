import { describe, it, expect } from 'vitest';
import { buildProcessingManifest } from '../src/science/processingManifest';
import {
  verifySessionManifest,
  sessionManifestNote,
} from '../src/science/verifySessionManifest';

/** A real, chain-valid manifest built the way the exporter builds it. */
function realManifest() {
  return buildProcessingManifest({
    build: '0.6.6 (abc1234)',
    source: 'site.laz',
    ops: [
      { method: 'olv.ground.smrf@1', params: {}, note: 'params not captured in this slice' },
      { method: 'olv.dtm.idw-fill@1', params: { coverageMode: 'full' } },
    ],
  });
}

describe('verifySessionManifest', () => {
  it("reports 'absent' when there is no manifest", () => {
    expect(verifySessionManifest(undefined)).toEqual({ status: 'absent' });
    expect(verifySessionManifest(null)).toEqual({ status: 'absent' });
  });

  it("reports 'verified' with the op count for a real, intact manifest", () => {
    const verdict = verifySessionManifest(realManifest());
    expect(verdict.status).toBe('verified');
    if (verdict.status === 'verified') {
      expect(verdict.ops).toBe(2);
      expect(typeof verdict.head).toBe('string');
    }
  });

  it("survives a serialize → parse round trip and still reports 'verified'", () => {
    const back = JSON.parse(JSON.stringify(realManifest())) as unknown;
    expect(verifySessionManifest(back)).toMatchObject({ status: 'verified', ops: 2 });
  });

  it("reports 'failed' when the chain is tampered", () => {
    const tampered = JSON.parse(JSON.stringify(realManifest()));
    tampered.ops[1].params = { coverageMode: 'partial' }; // edited op leaves the hash stale
    const verdict = verifySessionManifest(tampered);
    expect(verdict.status).toBe('failed');
    if (verdict.status === 'failed') expect(verdict.firstInvalidSeq).toBe(1);
  });

  it("reports 'legacy' for a manifest that does not match the recognized schema", () => {
    expect(verifySessionManifest({ foo: 1 })).toEqual({ status: 'legacy' });
    expect(verifySessionManifest(['anything', { nested: true }])).toEqual({ status: 'legacy' });
    // Right skeleton, wrong schema version.
    const wrongVersion = { ...realManifest(), schemaVersion: 999 };
    expect(verifySessionManifest(wrongVersion)).toEqual({ status: 'legacy' });
  });

  it('never throws on hostile or malformed input', () => {
    const inputs: unknown[] = [
      0,
      '',
      'a string',
      true,
      { ops: 'not-an-array', schemaVersion: 1, build: 'x', source: null, head: 'h' },
      { schemaVersion: 1, build: 'x', source: null, head: 'h', ops: [{ seq: 'no' }] },
      Object.create(null),
    ];
    for (const input of inputs) {
      expect(() => verifySessionManifest(input)).not.toThrow();
    }
  });
});

describe('sessionManifestNote', () => {
  it('says nothing when the manifest is absent', () => {
    expect(sessionManifestNote({ status: 'absent' })).toBeNull();
  });

  it('pluralizes the operation count', () => {
    expect(sessionManifestNote({ status: 'verified', ops: 1, head: 'h' })).toContain('1 operation)');
    expect(sessionManifestNote({ status: 'verified', ops: 3, head: 'h' })).toContain('3 operations)');
  });

  it('flags a failed check and labels a legacy manifest', () => {
    expect(sessionManifestNote({ status: 'failed' })).toContain('failed');
    expect(sessionManifestNote({ status: 'legacy' })).toContain('legacy');
  });
});
