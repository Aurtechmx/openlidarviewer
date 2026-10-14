/**
 * asciiExportSnapshots.test.ts
 *
 * The ASCII writers (XYZ, CSV, PLY, OBJ, and the converter's XYZ and ASC) emit
 * bytes in chunks. These specs pin the output against SHA-256 digests recorded
 * from the earlier single-string writers, across colour, intensity,
 * classification, CRS comments, provenance, digests, flagged-invalid
 * attributes, non-finite points and empty clouds. They also check that the
 * chunk size cannot change a byte, and that a cloud whose text outgrows a
 * single string is written without error.
 *
 * Set WRITE_ASCII_SNAPSHOTS=1 to rewrite the digest file.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toXyz, toCsv, toPly, toObj, toXyzBytes, toPlyBytes, toObjBytes, exportCloud, exportCloudBytes } from '../src/io/exporters';
import { writeXyz, writeAsc, writeXyzBytes, writeAscBytes } from '../src/convert/writeAscii';
import type { GlobalPoints } from '../src/convert/globalPoints';
import { exportDigests } from '../src/science/exportDigestRecord';
import { PointCloud } from '../src/model/PointCloud';
import { Utf8ChunkSink, StringLineSink, joinChunks } from '../src/io/textChunks';

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'asciiExportSnapshots.json');
const sha = (b: Uint8Array | string): string =>
  createHash('sha256').update(typeof b === 'string' ? Buffer.from(b, 'utf8') : b).digest('hex');

const D = exportDigests(
  { sha256: 'ab'.repeat(32), note: null },
  { source: 'las-vlr', name: 'NAD83(2011) / UTM zone 15N', epsg: 6344, verticalEpsg: 5703 },
);

const N = 9;
const positions = Float32Array.from({ length: N * 3 }, (_, i) => ((i * 37) % 101) / 7 - 3.3);
const colors = Uint8Array.from({ length: N * 3 }, (_, i) => (i * 29) % 256);
const intensity = Uint16Array.from({ length: N }, (_, i) => i * 7919);
const classification = Uint8Array.from({ length: N }, (_, i) => i % 7);
const SOURCE_META = {
  sourceMetadata: {
    standard: [
      { name: 'sensorModel', value: 'Synthetic scanner' },
      { name: 'license', value: 'CC0' },
    ],
    extensions: [],
  },
};

type Opts = ConstructorParameters<typeof PointCloud>[0];
const cloud = (extra: Partial<Opts> = {}, nonFinite = false): PointCloud => {
  const p = positions.slice();
  if (nonFinite) p[4] = Number.NaN;
  return new PointCloud({ positions: p, origin: [500000.25, 4100000.5, 12.125], sourceFormat: 'las', name: 'snap.las', ...extra });
};

const CLOUDS: Record<string, () => PointCloud> = {
  plain: () => cloud(),
  colour: () => cloud({ colors }),
  full: () => cloud({ colors, intensity, classification }),
  provenance: () => cloud({ colors, metadata: SOURCE_META as never }),
  flagged: () =>
    cloud({ colors, intensity, classification, attributeInvalid: Uint8Array.from({ length: N }, (_, i) => i % 4) }),
  nonFinite: () => cloud({ colors, intensity }, true),
  empty: () => new PointCloud({ positions: new Float32Array(0), origin: [0, 0, 0], sourceFormat: 'las', name: 'empty.las' }),
  derived: () => {
    const c = cloud({ classification });
    c.classMark = { state: 'derived', frame: 0, method: 'ground@1' };
    return c;
  },
};

const GN = 6;
const gx = Float64Array.from({ length: GN }, (_, i) => 500000.123456 + i * 1.5);
const gy = Float64Array.from({ length: GN }, (_, i) => 4100000.987654 - i * 2.25);
const gz = Float64Array.from({ length: GN }, (_, i) => 12.3456 + i);
const globalPoints = (extra: Partial<GlobalPoints> = {}): GlobalPoints => ({ count: GN, x: gx, y: gy, z: gz, ...extra });
const GLOBALS: Record<string, () => GlobalPoints> = {
  plain: () => globalPoints(),
  colour: () => globalPoints({ colors: Uint8Array.from({ length: GN * 3 }, (_, i) => i * 13) }),
  intensity: () => globalPoints({ intensity: Uint16Array.from({ length: GN }, (_, i) => i * 1000) }),
  flagged: () =>
    globalPoints({
      colors: Uint8Array.from({ length: GN * 3 }, (_, i) => i * 13),
      intensity: Uint16Array.from({ length: GN }, (_, i) => i * 1000),
      attributeInvalid: Uint8Array.from({ length: GN }, (_, i) => i % 4),
    }),
  empty: () => ({ count: 0, x: new Float64Array(0), y: new Float64Array(0), z: new Float64Array(0) }),
};
const PROV = ['software: OpenLiDARViewer test', 'source: site.las  sha256 ' + 'cd'.repeat(32)];
const CRS = { epsg: 32615, crsName: null };

/** Every writer output, keyed by case, as the text the writer produces. */
function outputs(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, make] of Object.entries(CLOUDS)) {
    for (const geo of [false, true]) {
      const tag = `${name}${geo ? '.geo' : ''}`;
      out[`xyz.${tag}`] = toXyz(make(), ' ', geo, D);
      out[`csv.${tag}`] = toCsv(make(), geo);
      out[`ply.${tag}`] = toPly(make(), geo, D);
      out[`obj.${tag}`] = toObj(make(), geo, D);
    }
  }
  for (const [name, make] of Object.entries(GLOBALS)) {
    out[`writeXyz.${name}`] = writeXyz(make());
    out[`writeXyz.${name}.crs`] = writeXyz(make(), 2, true, 'APPROXIMATE — datum shift', PROV, CRS);
    out[`writeXyz.${name}.named`] = writeXyz(make(), 3, false, null, null, { epsg: null, crsName: 'Local grid' });
    out[`writeAsc.${name}`] = writeAsc(make());
    out[`writeAsc.${name}.crs`] = writeAsc(make(), {
      precision: 2, epsg: 4326, geographic: true, datumNote: 'APPROXIMATE — datum shift', provenance: PROV,
    });
    out[`writeAsc.${name}.nocrs`] = writeAsc(make(), { crsName: 'Local grid' });
  }
  return out;
}

const digestsOf = (o: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, sha(v)]));

describe('ASCII writers match the recorded output', () => {
  if (process.env.WRITE_ASCII_SNAPSHOTS === '1') {
    it('writes the digest file', () => {
      writeFileSync(SNAPSHOT, JSON.stringify(digestsOf(outputs()), null, 1) + '\n');
    });
    return;
  }
  const recorded = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Record<string, string>;
  const now = outputs();

  it('covers every recorded case', () => {
    expect(Object.keys(now).sort()).toEqual(Object.keys(recorded).sort());
  });

  for (const key of Object.keys(recorded)) {
    it(`string output is unchanged: ${key}`, () => {
      expect(sha(now[key])).toBe(recorded[key]);
    });
  }
});

describe('byte output equals the string output, at any chunk size', () => {
  const enc = new TextEncoder();
  for (const [name, make] of Object.entries(CLOUDS)) {
    for (const chunk of [1, 40, 4096, undefined]) {
      it(`${name}, chunk ${chunk ?? 'default'}`, () => {
        const c = make();
        expect(toXyzBytes(c, ' ', true, D, chunk)).toEqual(enc.encode(toXyz(c, ' ', true, D)));
        expect(toXyzBytes(c, ',', false, undefined, chunk)).toEqual(enc.encode(toCsv(c, false)));
        expect(toPlyBytes(c, false, D, chunk)).toEqual(enc.encode(toPly(c, false, D)));
        expect(toObjBytes(c, true, D, chunk)).toEqual(enc.encode(toObj(c, true, D)));
        for (const f of ['xyz', 'csv', 'ply', 'obj'] as const) {
          expect(exportCloudBytes(c, f, false, D, chunk)).toEqual(enc.encode(exportCloud(c, f, false, D)));
        }
      });
    }
  }
  for (const [name, make] of Object.entries(GLOBALS)) {
    for (const chunk of [1, 64, undefined]) {
      it(`converter ${name}, chunk ${chunk ?? 'default'}`, () => {
        const g = make();
        expect(writeXyzBytes(g, 2, true, 'note', PROV, CRS, chunk)).toEqual(enc.encode(writeXyz(g, 2, true, 'note', PROV, CRS)));
        const o = { precision: 2, epsg: 6344, provenance: PROV };
        expect(writeAscBytes(g, o, chunk)).toEqual(enc.encode(writeAsc(g, o)));
      });
    }
  }
});

describe('line sinks', () => {
  it('cuts chunks only after a newline, so multi-byte text survives any chunk size', () => {
    const lines = ['# naïve — ✓ 😀', 'a b c', '😀😀😀', ''];
    const whole = new TextEncoder().encode(lines.join('\n') + '\n');
    for (const size of [1, 2, 3, 7]) {
      const sink = new Utf8ChunkSink(size);
      for (const l of lines) sink.line(l);
      expect(joinChunks(sink.chunks())).toEqual(whole);
    }
    const s = new StringLineSink();
    for (const l of lines) s.line(l);
    expect(s.text()).toBe(lines.join('\n') + '\n');
  });

  it('splits a large output into several bounded chunks', () => {
    const sink = new Utf8ChunkSink(1000);
    for (let i = 0; i < 5000; i++) sink.line('0123456789');
    const chunks = sink.chunks();
    expect(chunks.length).toBeGreaterThan(10);
    for (const c of chunks) expect(c.length).toBeLessThan(1100);
  });
});

describe('a large output is written in bounded chunks', () => {
  it('writes 6 million points as XYZ bytes, spread over many 4 Mi-character chunks', () => {
    const count = 6_000_000;
    const g: GlobalPoints = {
      count,
      x: new Float64Array(count).fill(500123.456),
      y: new Float64Array(count).fill(4100987.654),
      z: new Float64Array(count).fill(123.456),
    };
    const bytes = writeXyzBytes(g, 3);
    // 6M rows of "500123.456 4100987.654 123.456\n" (31 bytes) is 186 MB, spread
    // over about 45 chunks; no string in the writer grows past one chunk.
    expect(bytes.length).toBe(count * 31);
    expect(bytes[bytes.length - 1]).toBe(10);
  }, 120_000);
});
