import { describe, it, expect } from 'vitest';
import {
  LayerIdentityRegistry,
  fingerprintKey,
  newLayerId,
  type LayerFingerprint,
} from '../src/model/layerIdentity';

/** A distinct, deterministic id generator so tests never depend on randomness. */
function counterGen(): () => string {
  let n = 0;
  return () => `layer_test_${n++}`;
}

const scanA: LayerFingerprint = {
  fileName: 'survey.laz',
  sourcePoints: 1_000_000,
  width: 100,
  depth: 80,
  height: 12,
  epsg: 32612,
};

// Same display file NAME, genuinely different scan (different content) — the
// identity must come from the source fingerprint, never the filename.
const scanB_sameName: LayerFingerprint = {
  fileName: 'survey.laz',
  sourcePoints: 2_000_000,
  width: 250,
  depth: 40,
  height: 30,
  epsg: 32612,
};

describe('fingerprintKey — canonical, filename-independent source key', () => {
  it('is stable for identical facts and differs when content differs', () => {
    expect(fingerprintKey(scanA)).toBe(fingerprintKey({ ...scanA }));
    expect(fingerprintKey(scanA)).not.toBe(fingerprintKey(scanB_sameName));
  });

  it('does not change when only a display label would change (label is not a fact here)', () => {
    // fileName is the SOURCE name, part of the fingerprint; the mutable display
    // label lives on the record, not in the fingerprint.
    expect(fingerprintKey(scanA)).toBe(fingerprintKey({ ...scanA }));
  });
});

describe('newLayerId — generated identity, not derived from any name', () => {
  it('produces distinct ids that contain neither the filename nor a display label', () => {
    const a = newLayerId();
    const b = newLayerId();
    expect(a).not.toBe(b);
    expect(a.toLowerCase()).not.toContain('survey');
  });
});

describe('LayerIdentityRegistry', () => {
  it('gives two layers from duplicate filenames distinct ids', () => {
    const reg = new LayerIdentityRegistry({ generateId: counterGen() });
    const a = reg.resolve(scanA, 'survey.laz');
    const b = reg.resolve(scanB_sameName, 'survey.laz');
    expect(a.layerId).not.toBe(b.layerId);
  });

  it('does not change a layer id when the display label is renamed', () => {
    const reg = new LayerIdentityRegistry({ generateId: counterGen() });
    const rec = reg.resolve(scanA, 'survey.laz');
    const renamed = reg.rename(rec.layerId, 'North scarp — final');
    expect(renamed).not.toBeNull();
    expect(renamed!.layerId).toBe(rec.layerId);
    expect(renamed!.displayName).toBe('North scarp — final');
    expect(reg.get(rec.layerId)!.layerId).toBe(rec.layerId);
  });

  it('keeps ids stable under reordering (identity is by record, not position)', () => {
    const reg = new LayerIdentityRegistry({ generateId: counterGen() });
    const a = reg.resolve(scanA, 'A');
    const b = reg.resolve(scanB_sameName, 'B');
    const ordered = [a, b];
    const reordered = [...ordered].reverse();
    expect(reordered.map((r) => r.layerId)).toEqual([b.layerId, a.layerId]);
    // The registry still returns each record by its own id regardless of order.
    expect(reg.get(a.layerId)!.layerId).toBe(a.layerId);
    expect(reg.get(b.layerId)!.layerId).toBe(b.layerId);
  });

  it('reuses the same id when a scan with a matching fingerprint is reopened', () => {
    const reg = new LayerIdentityRegistry({ generateId: counterGen() });
    const first = reg.resolve(scanA, 'survey.laz');
    reg.remove(first.layerId); // the scan is closed
    const reopened = reg.resolve({ ...scanA }, 'survey.laz');
    expect(reopened.layerId).toBe(first.layerId);
  });

  it('gives a different scan a new id even after another scan was open', () => {
    const reg = new LayerIdentityRegistry({ generateId: counterGen() });
    const first = reg.resolve(scanA, 'survey.laz');
    reg.remove(first.layerId);
    const other = reg.resolve(scanB_sameName, 'survey.laz');
    expect(other.layerId).not.toBe(first.layerId);
  });

  it('adopts a stored id on session import, binding it to the fingerprint', () => {
    const reg = new LayerIdentityRegistry({ generateId: counterGen() });
    const adopted = reg.adopt('layer_from_session', scanA, 'survey.laz');
    expect(adopted.layerId).toBe('layer_from_session');
    // A later reopen of the same scan reuses the adopted id, not a fresh one.
    const reopened = reg.resolve({ ...scanA }, 'survey.laz');
    expect(reopened.layerId).toBe('layer_from_session');
  });
});
