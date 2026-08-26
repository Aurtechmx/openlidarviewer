/**
 * sample-profile-pdf.mjs — build one profile sheet from a synthetic section so
 * the layout can be looked at rather than only asserted.
 *
 * The fixture is deliberately awkward: a 40 m relief over 900 m and 181
 * stations, which is far more stations than the data band has room to label,
 * so the thinning path is the one that gets drawn. The date is fixed, for the
 * same reason the builder refuses to read the clock.
 *
 * Usage: npx vite-node scripts/sample-profile-pdf.mjs [outPath]
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProfilePdf } from '../src/render/measure/profilePdf.ts';

const samples = [];
for (let i = 0; i <= 180; i++) {
  const d = i * 5;
  samples.push({
    distance: d,
    height: 180 + Math.sin(d / 140) * 18 + Math.sin(d / 37) * 3 + d * 0.012,
  });
}

const bytes = await buildProfilePdf({
  name: 'Sample longitudinal section',
  samples,
  corridorWidthM: 4,
  groundPercentile: 15,
  crs: 'EPSG:32613',
  verticalDatum: null,
  generatedAt: new Date('2026-01-01T00:00:00.000Z'),
});
// A fixed path under the shared temp directory is predictable, so another
// user on the same machine can pre-create it and decide where these bytes
// land. Without an explicit destination this makes its own private directory
// instead, and prints where it went.
const out = process.argv[2] ?? join(mkdtempSync(join(tmpdir(), 'olv-profile-')), 'profile-sample.pdf');
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.byteLength} bytes)`);
