/**
 * Published observations, not a synthetic distribution: 2,000 real records of
 * LA03mapry.laz (Hrdina, M., Zenodo 10.5281/zenodo.15421291, CC BY 4.0,
 * OLV-DS-054), copied unchanged by scripts/zenodo-study/extract-la03-fixture.py
 * from source indices 0, 15,783, 31,566 ... (stride 15,783 over 31,566,748).
 *
 * The scan's colour channel exists and is near-uniform grey. Opening it must
 * not pick RGB; the pick must be another supported mode with a short reason,
 * and RGB must stay selectable by hand. The iPhone side (readable RGB kept)
 * runs on the real cloud in `npm run validate:zenodo-small`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadLas } from '../src/io/loadLas';
import { readRgbReadability } from '../src/render/rgbReadability';
import { recommendColorMode } from '../src/render/colorModeRecommend';
import { cloudSupportsColorMode } from '../src/render/colorModeSupport';

const PATH = new URL('./fixtures/zenodo-15421291/OLV-DS-054-la03-sample.las', import.meta.url);
const SHA256 = 'f3be904b142674061cfcb196ba209da545014cf39b4fe2f64ef8c0f0b118a1a8';

function bytes(): ArrayBuffer {
  const b = readFileSync(PATH);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

describe('LA03 sample (real records): opening colour', () => {
  it('is the committed extraction', () => {
    expect(createHash('sha256').update(new Uint8Array(bytes())).digest('hex')).toBe(SHA256);
  });

  it('keeps the source quantisation and reads 2,000 points', async () => {
    const cloud = await loadLas(bytes(), 'las', 'LA03mapry-sample.las');
    expect(cloud.pointCount).toBe(2000);
    expect(cloud.metadata?.pointFormat).toBe(2);
    expect(cloud.metadata?.sourceQuantisation?.scale).toEqual([0.0001, 0.0001, 0.0001]);
    expect(cloud.metadata?.sourceQuantisation?.offset).toEqual([-744300, -1036280, 310]);
  });

  it('measures the RGB as uniform, opens in another supported mode, and leaves RGB selectable', async () => {
    const cloud = await loadLas(bytes(), 'las', 'LA03mapry-sample.las');
    expect(readRgbReadability(cloud.colors).verdict).toBe('uniform');
    const rec = recommendColorMode(cloud);
    expect(rec.mode).not.toBe('rgb');
    expect(cloudSupportsColorMode(cloud, rec.mode)).toBe(true);
    expect(cloudSupportsColorMode(cloud, 'rgb')).toBe(true);
    expect(rec.reason.length).toBeGreaterThan(0);
    expect(rec.reason.length).toBeLessThan(200);
  });
});
