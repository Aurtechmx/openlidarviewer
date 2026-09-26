/**
 * intakeCorpusManifest.test.ts: integrity of the intake recovery corpus.
 *
 * The corpus under validation/intake-corpus/ is regenerated from seeds rather
 * than committed. This test checks that the committed manifest still describes
 * what the generator produces, that the committed inputs (criteria, protocol,
 * generator, seed files) match their pinned hashes, and that the held-out split
 * is disjoint from the tuning split in ids, content, seeds, real points and
 * layouts. A changed criteria.json fails here, which is the point: the
 * thresholds are pre-registered.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain ESM generator without type declarations
import { generateCorpus, buildManifest, sha256, CORPUS_DIR, COMMITTED_FILES } from '../validation/intake-corpus/generate.mjs';

type Entry = {
  id: string; split: string; label: string; category: string; seed: number;
  sha256: string; bytes: number; layoutKey?: string; source: string;
  pointCount?: number; truthSha256?: string;
};

const manifest = JSON.parse(readFileSync(join(CORPUS_DIR, 'manifest.json'), 'utf8'));
const criteria = JSON.parse(readFileSync(join(CORPUS_DIR, 'criteria.json'), 'utf8'));
const entries: Entry[] = manifest.samples;
const bySplit = (s: string) => entries.filter((e) => e.split === s);

describe('intake corpus manifest', () => {
  it('pins every committed input by hash', () => {
    expect(Object.keys(manifest.committedFiles).sort()).toEqual([...COMMITTED_FILES].sort());
    for (const [path, hash] of Object.entries(manifest.committedFiles)) {
      expect(sha256(readFileSync(join(CORPUS_DIR, path))), path).toBe(hash);
    }
  });

  it('matches a fresh regeneration byte for byte', () => {
    const fresh = buildManifest(generateCorpus());
    expect(fresh.samples).toEqual(manifest.samples);
    expect(fresh.summary).toEqual(manifest.summary);
  });

  it('keeps the splits disjoint', () => {
    const tun = bySplit('tuning');
    const held = bySplit('heldout');
    expect(tun.length + held.length).toBe(entries.length);
    const disjoint = (k: keyof Entry) => {
      const a = new Set(tun.map((e) => e[k]));
      return held.filter((e) => a.has(e[k])).map((e) => e.id);
    };
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    expect(disjoint('id')).toEqual([]);
    expect(disjoint('sha256')).toEqual([]);
    expect(disjoint('seed')).toEqual([]);
    const tunLayouts = new Set(tun.filter((e) => e.label === 'positive').map((e) => e.layoutKey));
    expect(held.filter((e) => e.label === 'positive' && tunLayouts.has(e.layoutKey))).toEqual([]);
    // Truth point sets of real-data positives never repeat across splits.
    expect(disjoint('truthSha256').filter((id) => !id.includes('-neg-'))).toEqual([]);
  });

  it('meets the pre-registered minimum held-out size', () => {
    const held = bySplit('heldout');
    expect(held.filter((e) => e.label === 'positive').length).toBeGreaterThanOrEqual(criteria.minimumHeldOutSize.positives);
    expect(held.filter((e) => e.label === 'negative').length).toBeGreaterThanOrEqual(criteria.minimumHeldOutSize.negatives);
    expect(criteria.thresholds).toEqual({
      negativeFalsePositiveRateMax: 0.01,
      positiveLayoutExactRateMin: 0.9,
      offeredCoordinateRelativeErrorMax: 1e-6,
    });
  });

  it('covers every required sample family in both splits', () => {
    const negKinds = ['random-bytes', 'deflate', 'pcm-audio', 'image-pixels', 'f32-signal', 'f32-sorted', 'mesh-interleaved', 'text-log', 'csv-table'];
    for (const split of ['tuning', 'heldout']) {
      const cats = new Set(bySplit(split).map((e) => e.category));
      for (const k of negKinds) expect(cats.has(k), `${split} ${k}`).toBe(true);
      const sources = new Set(bySplit(split).filter((e) => e.label === 'positive').map((e) => e.source));
      expect(sources.has('OLV-DS-090') && sources.has('OLV-DS-093'), split).toBe(true);
    }
  });

  it('draws real points only from register datasets with a redistributable licence', () => {
    const register = readFileSync(join(CORPUS_DIR, '../datasets/dataset-register.yaml'), 'utf8');
    for (const src of Object.values(manifest.sources) as { datasetId: string; licence: string }[]) {
      expect(register).toContain(`datasetId: ${src.datasetId}`);
      expect(['CC-BY-4.0', 'public-domain']).toContain(src.licence);
    }
    for (const e of entries) expect(e.source === 'synthetic' || e.source.startsWith('synthetic:') || e.source in manifest.sources).toBe(true);
  });
});
