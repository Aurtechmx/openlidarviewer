/**
 * The deterministic terrain-like cloud both TerrainCore benchmarks run on: a
 * smooth rolling surface over a 1000 m span plus small noise, seeded so every
 * run sees the same points.
 */
export function makeTerrainBenchCloud(n: number): Float32Array {
  const xyz = new Float32Array(n * 3);
  let s = 123456789 >>> 0;
  const rnd = (): number => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const side = Math.ceil(Math.sqrt(n));
  const span = 1000;
  for (let i = 0; i < n; i++) {
    const gx = (i % side) / side;
    const gy = Math.floor(i / side) / side;
    xyz[i * 3] = gx * span + (rnd() - 0.5) * 0.5;
    xyz[i * 3 + 1] = gy * span + (rnd() - 0.5) * 0.5;
    xyz[i * 3 + 2] = 200 + 8 * Math.sin(gx * 12) * Math.cos(gy * 9) + (rnd() - 0.5) * 0.3;
  }
  return xyz;
}
