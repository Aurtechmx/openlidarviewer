/**
 * groundFilterProducerAgreement.test.ts — OLV's ground filter vs an INDEPENDENT
 * producer ground classification on a real airborne scene.
 *
 * Every ground-filter check the project ships today is against a SYNTHETIC scene
 * (ground membership known by construction) or an AGREEMENT with another
 * ALGORITHM (PDAL SMRF). This scores the filter against a REAL cloud whose
 * ground/non-ground labels were assigned by an independent producer, so the
 * number is accuracy against a labelling this project did not write.
 *
 * WHAT THIS IS AND IS NOT. The producer classification is a REFERENCE labelling,
 * not survey checkpoints: it is itself a classifier's output and can err, so a
 * disagreement is a finding to read, not proof of a fault. This is real-terrain
 * evidence a step beyond the synthetic corpus — it is NOT survey-grade accuracy
 * and promotes no claim to E5, which still requires independent checkpoints.
 *
 * REPRODUCIBILITY. It runs against the LAS or LAZ/COPC named by `GF_SCENE`, and
 * skips when that is unset — no data is committed to the repo, and no dataset of
 * unstated licence is registered as evidence. `GF_STRIDE=N` subsamples a large
 * tile (e.g. a full 3DEP `.laz`) so a Node run stays bounded. A caller with a
 * producer-classified scene runs:
 *
 *     GF_SCENE=/path/to/tile.laz GF_STRIDE=10 npx vitest run tests/groundFilterProducerAgreement.test.ts
 *
 * Observed data points (exploratory, licences unverified, not registered): on
 * natural terrain OLV's filter tracks the producer closely (F1 ≈ 0.95, MCC ≈
 * 0.92); on a complex urban scene precision falls (≈ 0.34) as flat building
 * roofs are read as ground — a known morphological-filter weakness.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseLasHeader } from '../src/io/lasHeader';
import { allocRawPoints, decodeContext, decodeRecord, type RawPoints } from '../src/io/lasDecodeShared';
import { decodeLaz } from '../src/io/lazDecode';
import { deriveClassification, DERIVED_GROUND } from '../src/render/class/deriveClassification';

const SCENE = process.env.GF_SCENE;
// Subsample a large tile so a Node run stays bounded; stride keeps one record
// per bucket at a jittered offset, so the sample does not band along scan lines.
// Both OLV's codes and the producer labels are read on the SAME sampled points,
// so the comparison stays valid — it is a smaller scene, not a biased one.
const STRIDE = Math.max(1, Math.floor(Number(process.env.GF_STRIDE ?? '1')));
const PRODUCER_GROUND = 2; // ASPRS class 2 = ground

/** Decode a plain LAS (uncompressed) or a .laz/COPC into RawPoints. */
async function decodeScene(path: string): Promise<{ out: RawPoints; count: number }> {
  const bytes = readFileSync(path);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const header = parseLasHeader(buf);
  const compressed = /\.(laz|copc\.laz)$/i.test(path);
  if (compressed) {
    const out = await decodeLaz(buf, header, [0, 0, 0], STRIDE);
    return { out, count: Math.ceil(header.pointCount / STRIDE) };
  }
  const count = header.pointCount;
  const view = new DataView(buf);
  const ctx = decodeContext(header, [0, 0, 0]);
  const out = allocRawPoints(count, false, false);
  for (let i = 0; i < count; i++) {
    decodeRecord(view, header.offsetToPointData + i * header.pointDataRecordLength, i, ctx, out);
  }
  return { out, count };
}

describe.skipIf(!(SCENE && existsSync(SCENE)))(
  'OLV ground filter vs producer ground on a real scene',
  () => {
    it('scores accuracy against the independent producer classification', async () => {
      const { out, count } = await decodeScene(SCENE!);

      let producerGroundN = 0;
      const truthGround = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        if (out.classification[i] === PRODUCER_GROUND) {
          truthGround[i] = 1;
          producerGroundN++;
        }
      }

      const codes = deriveClassification(out.positions, count, {}).codes;

      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;
      for (let i = 0; i < count; i++) {
        const pred = codes[i] === DERIVED_GROUND ? 1 : 0;
        if (truthGround[i] && pred) tp++;
        else if (!truthGround[i] && pred) fp++;
        else if (truthGround[i] && !pred) fn++;
        else tn++;
      }
      const recall = tp / Math.max(1, tp + fn);
      const precision = tp / Math.max(1, tp + fp);
      const f1 = (2 * precision * recall) / Math.max(1e-9, precision + recall);
      const mccDen = Math.sqrt((tp + fp) * (tp + fn) * (tn + fp) * (tn + fn)) || 1;
      const mcc = (tp * tn - fp * fn) / mccDen;

      // eslint-disable-next-line no-console
      console.log(
        [
          `scene: ${SCENE!.split('/').pop()}  points: ${count.toLocaleString('en-US')}`,
          `producer ground: ${((producerGroundN / count) * 100).toFixed(1)}%`,
          `confusion  tp=${tp} fp=${fp} fn=${fn} tn=${tn}`,
          `recall=${recall.toFixed(3)}  precision=${precision.toFixed(3)}  F1=${f1.toFixed(3)}  MCC=${mcc.toFixed(3)}`,
        ].join('\n'),
      );

      // Sanity only — the scene carries a producer ground class and the filter
      // returned a code for every point. No accuracy floor is asserted: the
      // producer labelling is a reference, not a survey truth to gate against.
      expect(producerGroundN).toBeGreaterThan(0);
      expect(codes.length).toBe(count);
    });
  },
);
