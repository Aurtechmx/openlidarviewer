import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { distance } from '../src/render/measure/geometry';
import { registerTiePoints, type Vec3 } from '../src/geo/tiePointRegister';

/**
 * Real-data leg of the control-network study (see
 * validation/control-network/README.md). Two scanner-local scans of one site
 * carry the SAME surveyed targets, each in its own frame. Two properties must
 * hold, and both are checked here through OLV's own code:
 *
 *   1. inter-target distances are rigid-invariant across the two frames
 *      (OLV's `geometry.distance` measures the surveyed network consistently);
 *   2. the shared targets register one frame onto the other to a small residual
 *      (`registerTiePoints`), which is what a tie-point alignment of the clouds
 *      would achieve.
 *
 * Runs only when `OLV_CONTROL_NETWORK_DIR` holds `*_vertices.txt` files
 * (`TargetID,X,Y,Z`; blank-id rows — the scanner origin — are ignored). The
 * surveyed coordinates are private, so nothing is committed and CI skips this;
 * `tests/tiePointRegister.test.ts` covers the solver on synthetic data.
 */
const DIR = process.env.OLV_CONTROL_NETWORK_DIR;

/** OLV's `distance` takes a mutable Vec3; copy the readonly tie-point tuples. */
const dist = (p: Vec3, q: Vec3): number => distance([p[0], p[1], p[2]], [q[0], q[1], q[2]]);

interface Network {
  file: string;
  targets: Map<string, Vec3>;
}

function parseVertices(path: string, file: string): Network {
  const targets = new Map<string, Vec3>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const cells = line.split(',');
    if (cells.length < 4) continue;
    const id = cells[0].trim();
    if (!id || id.toLowerCase() === 'targetid') continue; // header / origin row
    const x = Number(cells[1]), y = Number(cells[2]), z = Number(cells[3]);
    if ([x, y, z].every(Number.isFinite)) targets.set(id, [x, y, z]);
  }
  return { file, targets };
}

const networks: Network[] = [];
if (DIR && existsSync(DIR)) {
  for (const f of readdirSync(DIR)) {
    if (f.toLowerCase().endsWith('_vertices.txt')) {
      const net = parseVertices(join(DIR, f), f);
      if (net.targets.size >= 3) networks.push(net);
    }
  }
}

// Every pair of networks sharing at least three targets is a comparable frame pair.
const pairs: Array<[Network, Network, string[]]> = [];
for (let i = 0; i < networks.length; i++) {
  for (let j = i + 1; j < networks.length; j++) {
    const shared = [...networks[i].targets.keys()].filter((k) => networks[j].targets.has(k));
    if (shared.length >= 3) pairs.push([networks[i], networks[j], shared]);
  }
}

describe.skipIf(pairs.length === 0)('control network across scan frames (real surveyed targets)', () => {
  for (const [a, b, shared] of pairs) {
    it(`${a.file} ↔ ${b.file}: distances invariant and frames register`, () => {
      // 1. Inter-target distances agree across frames (OLV geometry.distance).
      for (let i = 0; i < shared.length; i++) {
        for (let j = i + 1; j < shared.length; j++) {
          const da = dist(a.targets.get(shared[i])!, a.targets.get(shared[j])!);
          const db = dist(b.targets.get(shared[i])!, b.targets.get(shared[j])!);
          expect(Math.abs(da - db)).toBeLessThan(0.05); // 50 mm — survey consistency
        }
      }
      // 2. The shared targets register frame B onto frame A tightly.
      const src = shared.map((k) => b.targets.get(k)!);
      const dst = shared.map((k) => a.targets.get(k)!);
      const tf = registerTiePoints(src, dst);
      expect(tf.rmsResidual).toBeLessThan(0.05); // 50 mm
    });
  }
});
