/**
 * processingManifest.test.ts
 *
 * The verify-only processing-provenance manifest: an ordered, hash-chained
 * record of the methods + parameters that produced a terrain export. These
 * tests pin the three properties the manifest exists to provide:
 *
 *   1. DETERMINISM — the same inputs always build the same chain and head, so
 *      two parties can independently confirm they hold the same history.
 *   2. TAMPER-EVIDENCE — editing any op (params, method, order), truncating the
 *      chain, or rewording the build/source envelope breaks verification at
 *      exactly the first altered position.
 *   3. HONESTY — the module claims verification only. No executor exists, so
 *      the module (and this file) must never suggest the manifest can re-run
 *      anything; a source grep pins that wording discipline.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PROCESSING_MANIFEST_SCHEMA,
  buildProcessingManifest,
  verifyProcessingManifest,
  type ProcessingManifest,
  type ProcessingOpInput,
} from '../src/science/processingManifest';
import { canonicalize, sha256 } from '../src/render/measure/auditLog';

/** A small, realistic op sequence (ids mirror the terrain pipeline's). */
function sampleOps(): ProcessingOpInput[] {
  return [
    { method: 'olv.ground.smrf@1', params: {}, note: 'params not captured in this slice' },
    { method: 'olv.dtm.idw-fill@1', params: { coverageMode: 'full' } },
    { method: 'olv.terrain.vrm@1', params: { windowCells: 3, windowGroundM: 3.2 } },
  ];
}

function sampleManifest(): ProcessingManifest {
  return buildProcessingManifest({
    build: '0.5.9 (abc1234, release channel, built 2026-07-01T00:00:00Z)',
    source: 'site.laz',
    ops: sampleOps(),
  });
}

describe('buildProcessingManifest — shape and chain construction', () => {
  it('stamps the schema version, build, source, and one hashed op per input', () => {
    const m = sampleManifest();
    expect(m.schemaVersion).toBe(PROCESSING_MANIFEST_SCHEMA);
    expect(PROCESSING_MANIFEST_SCHEMA).toBe(1);
    expect(m.build).toContain('0.5.9');
    expect(m.source).toBe('site.laz');
    expect(m.ops).toHaveLength(3);
    m.ops.forEach((op, i) => {
      expect(op.seq).toBe(i);
      expect(op.hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  it('chains each op hash over the previous hash + the canonical entry', () => {
    const m = sampleManifest();
    // The chain is seeded from the manifest envelope (schema, build, source),
    // so the envelope itself is covered by the very first op hash.
    const genesis = sha256(
      '0|' + canonicalize({ schemaVersion: m.schemaVersion, build: m.build, source: m.source }),
    );
    let prev = genesis;
    for (const op of m.ops) {
      const expected = sha256(
        prev + '|' + canonicalize({ seq: op.seq, method: op.method, params: op.params, note: op.note }),
      );
      expect(op.hash).toBe(expected);
      prev = op.hash;
    }
    expect(m.head).toBe(prev);
  });

  it('is deterministic: the same inputs produce the identical manifest and head', () => {
    const a = sampleManifest();
    const b = sampleManifest();
    expect(a).toEqual(b);
    expect(a.head).toBe(b.head);
  });

  it('different params produce a different head', () => {
    const a = sampleManifest();
    const ops = sampleOps();
    ops[1] = { ...ops[1], params: { coverageMode: 'sampled' } };
    const b = buildProcessingManifest({ build: a.build, source: a.source, ops });
    expect(b.head).not.toBe(a.head);
  });

  it('an empty op list yields head = the envelope genesis and still verifies', () => {
    const m = buildProcessingManifest({ build: 'b', source: null, ops: [] });
    expect(m.ops).toHaveLength(0);
    expect(m.head).toBe(sha256('0|' + canonicalize({ schemaVersion: 1, build: 'b', source: null })));
    expect(verifyProcessingManifest(m)).toEqual({ ok: true });
  });

  it('a note-free op hashes identically to one with note explicitly undefined', () => {
    // canonicalize skips undefined keys (matching JSON.stringify), so an op
    // whose optional note was never set survives a JSON round trip verbatim.
    const withUndef = buildProcessingManifest({
      build: 'b',
      source: null,
      ops: [{ method: 'olv.dtm.idw-fill@1', params: { coverageMode: 'full' }, note: undefined }],
    });
    const without = buildProcessingManifest({
      build: 'b',
      source: null,
      ops: [{ method: 'olv.dtm.idw-fill@1', params: { coverageMode: 'full' } }],
    });
    expect(withUndef.head).toBe(without.head);
  });
});

describe('verifyProcessingManifest — tamper detection', () => {
  it('accepts an untouched manifest', () => {
    expect(verifyProcessingManifest(sampleManifest())).toEqual({ ok: true });
  });

  it('accepts a manifest after a JSON round trip (the export path)', () => {
    const m = JSON.parse(JSON.stringify(sampleManifest())) as ProcessingManifest;
    expect(verifyProcessingManifest(m)).toEqual({ ok: true });
  });

  it('reports the exact op whose params were tampered with', () => {
    const m = sampleManifest();
    const tampered: ProcessingManifest = {
      ...m,
      ops: m.ops.map((op, i) =>
        i === 1 ? { ...op, params: { coverageMode: 'resident-only' } } : op,
      ),
    };
    expect(verifyProcessingManifest(tampered)).toEqual({ ok: false, firstInvalid: 1 });
  });

  it('reports the exact op whose method was rewritten', () => {
    const m = sampleManifest();
    const tampered: ProcessingManifest = {
      ...m,
      ops: m.ops.map((op, i) => (i === 2 ? { ...op, method: 'olv.terrain.tpi@1' } : op)),
    };
    expect(verifyProcessingManifest(tampered)).toEqual({ ok: false, firstInvalid: 2 });
  });

  it('detects reordering at the first out-of-place op', () => {
    const m = sampleManifest();
    const tampered: ProcessingManifest = { ...m, ops: [m.ops[1], m.ops[0], m.ops[2]] };
    expect(verifyProcessingManifest(tampered)).toEqual({ ok: false, firstInvalid: 0 });
  });

  it('detects a truncated chain via the recorded head (index = ops.length)', () => {
    const m = sampleManifest();
    const tampered: ProcessingManifest = { ...m, ops: m.ops.slice(0, 2) };
    expect(verifyProcessingManifest(tampered)).toEqual({ ok: false, firstInvalid: 2 });
  });

  it('detects an edited source envelope from the very first op', () => {
    const m = sampleManifest();
    const tampered: ProcessingManifest = { ...m, source: 'other.laz' };
    expect(verifyProcessingManifest(tampered)).toEqual({ ok: false, firstInvalid: 0 });
  });

  it('detects an edited build envelope even on an op-free manifest', () => {
    const m = buildProcessingManifest({ build: 'b', source: null, ops: [] });
    const tampered: ProcessingManifest = { ...m, build: 'forged' };
    expect(verifyProcessingManifest(tampered)).toEqual({ ok: false, firstInvalid: 0 });
  });
});

describe('honesty — verify-only wording', () => {
  it('the module never suggests it can re-run anything (no re-execution wording)', () => {
    const src = readFileSync(
      new URL('../src/science/processingManifest.ts', import.meta.url),
      'utf8',
    );
    // The honest claim is a VERIFIABLE manifest (ordering + params +
    // tamper-evidence). No executor exists, so the word that would imply one
    // must not appear anywhere in the module.
    expect(/replay/i.test(src)).toBe(false);
  });
});
