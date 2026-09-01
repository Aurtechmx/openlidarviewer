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
 * Observed data points (exploratory, producer labels are a REFERENCE not survey
 * truth). Four independently-labelled scenes across the difficulty spectrum:
 *
 *   scene                         land cover        recall  prec.  F1     MCC
 *   ----------------------------  ----------------  ------  -----  -----  -----
 *   open natural (4_6.las)        bare / low relief  —      —      0.951  0.917
 *   Jemez snow-off (OLV-DS-090)   montane forest    0.884  0.625  0.732  0.629
 *   Rogue 3DEP (OLV-DS-091)       dense canopy      0.918  0.338  0.494  0.531
 *   urban (autzen)                buildings          —     0.340   —      —
 *
 * Consistent pattern: recall stays high everywhere, precision collapses where
 * something flat sits above ground — dense canopy (Rogue, ~4% producer ground)
 * and building roofs (urban) both read as ground, the known morphological-filter
 * weakness. Jemez and Rogue carry verified licences (CC BY 4.0; US-Government
 * public domain) and are registered as OLV-DS-090/091; the numbers reproduce via
 * GF_SCENE. None of this is survey-grade and none promotes a claim to E5, which
 * still requires independent checkpoints.
 *
 * OpenGF corpus (OLV-DS-092, finely hand-labelled GR=class 2 per the CVPRW2021
 * paper §4.3; run each scene via GF_SCENE). Nine 500 m tiles, one per terrain
 * scene, span a deliberate difficulty gradient:
 *
 *   scene  terrain (paper §3.2)             recall  prec.  F1     MCC
 *   -----  -------------------------------  ------  -----  -----  -----
 *   S4     small-city undulating            0.996  0.952  0.974  0.947
 *   S3     small-city flat                  0.994  0.930  0.961  0.916
 *   S2     metropolis dense-roofs           0.998  0.901  0.947  0.922
 *   S1     metropolis large-roofs           0.998  0.781  0.876  0.767
 *   S5     small-city rugged                0.957  0.782  0.861  0.778
 *   S6     village scattered-buildings      0.755  0.960  0.846  0.720
 *   S8     mountain steep + sparse veg      0.665  0.558  0.607  0.448
 *   S7     mountain gentle + dense veg      0.956  0.349  0.511  0.496
 *   S9     mountain steep + dense veg       0.700  0.398  0.508  0.468
 *
 * The filter is strongest on small-city flat/undulating terrain and collapses on
 * all three MOUNTAIN scenes (steep slope and/or dense vegetation) — the terrain
 * the paper itself calls hardest — and on metropolis large roofs (read as
 * ground). OpenGF labels are a high-quality REFERENCE, not survey checkpoints:
 * still not E5.
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
    }, 180_000); // decode + derive over a multi-million-point real tile exceeds the default 15 s cap
  },
);
