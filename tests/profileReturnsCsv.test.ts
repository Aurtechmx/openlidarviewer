import { describe, it, expect } from 'vitest';
import {
  buildProfileReturnsCsv,
  type ProfileReturnsCsvOptions,
  type ProfileReturnsSource,
} from '../src/render/measure/profileReturnsCsv';
import {
  ProfileSectionBuilder,
  type ProfileSectionPoints,
  type ProfileSourceChannels,
} from '../src/render/measure/profileSectionBuilder';
import type { VerticalReference } from '../src/geo/height';

const AT = '2026-08-23T00:00:00.000Z';

/** Minimal RFC 4180 reader, so the round-trip test parses with no knowledge of the writer. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function baseOptions(sources: readonly ProfileReturnsSource[]): ProfileReturnsCsvOptions {
  return {
    measurementId: 'm-1',
    measurementName: 'Section A',
    a: [0, 0, 0],
    b: [10, 0, 0],
    up: [0, 0, 2],
    corridorHalfWidth: 1.5,
    verticalReference: 'orthometric',
    sources,
    generatedAt: AT,
    unitToMetres: 1,
    unitName: 'metre',
  };
}

/** A section whose two slots disagree about which channels they carry. */
function mixedSection(): ProfileSectionPoints {
  const b = new ProfileSectionBuilder();
  const rich: ProfileSourceChannels = {
    intensity: new Uint16Array([0, 7]),
    classification: new Uint8Array([2, 5]),
    returnNumber: new Uint8Array([1, 2]),
    returnCount: new Uint8Array([2, 2]),
    pointSourceId: new Uint16Array([11, 11]),
    gpsTime: new Float64Array([100.5, 100.75]),
    rgb: new Uint8Array([10, 20, 30, 40, 50, 60]),
  };
  b.beginSource(0, rich, 2);
  b.push(0, 1, 100.25, -0.5);
  b.push(1, 2, 101.5, 0.25);
  // Second layer carries coordinates only, no attribute channels at all.
  b.beginSource(1, null, 2);
  b.push(0, 3, 102, 0.75);
  return b.finish();
}

const MIXED_SOURCES: ProfileReturnsSource[] = [
  {
    slot: 0,
    layerId: 'L0',
    layerName: 'survey.laz',
    classificationSource: 'source',
    readXYZ: (index: number, out: Float64Array): boolean => {
      const coords = [500000.111, 4000000.222, 100.25, 500001, 4000001, 101.5];
      if ((index + 1) * 3 > coords.length) return false;
      out[0] = coords[index * 3]!;
      out[1] = coords[index * 3 + 1]!;
      out[2] = coords[index * 3 + 2]!;
      return true;
    },
  },
  { slot: 1, layerId: 'L1', layerName: 'scan.e57', classificationSource: 'none' },
];

function rowsOf(csv: string): { header: string[]; body: string[][] } {
  const parsed = parseCsv(csv);
  return { header: parsed[0]!, body: parsed.slice(1) };
}

function col(header: string[], body: string[][], name: string): string[] {
  const i = header.indexOf(name);
  expect(i, `column ${name} is missing`).toBeGreaterThanOrEqual(0);
  return body.map((r) => r[i]!);
}

describe('profile returns CSV — absent channels', () => {
  it('writes a blank cell for a channel a source does not carry, never a zero', () => {
    const { csv } = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    const { header, body } = rowsOf(csv);
    expect(body).toHaveLength(3);

    // The distinction the whole export exists to preserve: an OBSERVED 0 and an
    // ABSENT channel are different cells.
    expect(col(header, body, 'intensity')).toEqual(['0', '7', '']);
    expect(col(header, body, 'classification')).toEqual(['2', '5', '']);
    expect(col(header, body, 'classification_label')).toEqual(['Ground', 'High vegetation', '']);
    expect(col(header, body, 'return_number')).toEqual(['1', '2', '']);
    expect(col(header, body, 'return_count')).toEqual(['2', '2', '']);
    expect(col(header, body, 'point_source_id')).toEqual(['11', '11', '']);
    expect(col(header, body, 'gps_time')).toEqual(['100.500000', '100.750000', '']);
    expect(col(header, body, 'r')).toEqual(['10', '40', '']);
    expect(col(header, body, 'g')).toEqual(['20', '50', '']);
    expect(col(header, body, 'b')).toEqual(['30', '60', '']);
  });

  it('omits a column entirely when no source carries the channel', () => {
    const b = new ProfileSectionBuilder();
    b.beginSource(0, { intensity: new Uint16Array([5]) }, 1);
    b.push(0, 0, 1, 0);
    const { csv } = buildProfileReturnsCsv(
      b.finish(),
      baseOptions([{ slot: 0, layerId: 'L0', layerName: 'a.las' }]),
    );
    const { header } = rowsOf(csv);
    expect(header).toContain('intensity');
    for (const absent of ['classification', 'gps_time', 'return_number', 'r', 'g', 'b']) {
      expect(header).not.toContain(absent);
    }
  });

  it('leaves x/y/z blank for a layer that supplied no coordinates', () => {
    const { csv } = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    const { header, body } = rowsOf(csv);
    expect(col(header, body, 'x')).toEqual(['500000.111', '500001.000', '']);
    expect(col(header, body, 'z')).toEqual(['100.250', '101.500', '']);
  });
});

describe('profile returns CSV — full accepted set', () => {
  it('exports every accepted return when a display subset is supplied', () => {
    const section = mixedSection();
    const full = buildProfileReturnsCsv(section, baseOptions(MIXED_SOURCES));
    const thinned = buildProfileReturnsCsv(section, {
      ...baseOptions(MIXED_SOURCES),
      displayedIndices: new Uint32Array([0]),
      visualLodInUse: true,
    });

    expect(rowsOf(full.csv).body).toHaveLength(section.count);
    expect(rowsOf(thinned.csv).body).toHaveLength(section.count);
    // The subset changes the RECEIPT and nothing else about the file.
    expect(thinned.csv).toBe(full.csv);
    expect(thinned.receipt.acceptedCount).toBe(3);
    expect(thinned.receipt.displayedCount).toBe(1);
    expect(thinned.receipt.visualLodInUse).toBe(true);
    expect(full.receipt.displayedCount).toBeNull();
  });

  it('keeps a row for every return even when a huge display subset is passed', () => {
    const section = mixedSection();
    const { csv } = buildProfileReturnsCsv(section, {
      ...baseOptions(MIXED_SOURCES),
      displayedIndices: [0, 1, 2, 0, 1],
    });
    expect(rowsOf(csv).body).toHaveLength(3);
  });
});

describe('profile returns CSV — vertical datum names the column', () => {
  const cases: Array<[VerticalReference, string]> = [
    ['orthometric', 'elevation'],
    ['ellipsoidal', 'height'],
    ['depth', 'height'],
    ['local', 'height'],
    ['unknown', 'height'],
  ];
  for (const [reference, expected] of cases) {
    it(`names the column ${expected} for a ${reference} reference`, () => {
      const { csv, receipt } = buildProfileReturnsCsv(mixedSection(), {
        ...baseOptions(MIXED_SOURCES),
        verticalReference: reference,
      });
      const { header } = rowsOf(csv);
      expect(header).toContain(expected);
      expect(header).not.toContain(expected === 'height' ? 'elevation' : 'height');
      expect(receipt.vertical.column).toBe(expected);
      expect(receipt.vertical.reference).toBe(reference);
    });
  }

  it('never calls an undeclared datum an elevation', () => {
    const { csv } = buildProfileReturnsCsv(mixedSection(), {
      ...baseOptions(MIXED_SOURCES),
      verticalReference: 'unknown',
    });
    expect(rowsOf(csv).header).not.toContain('elevation');
  });
});

describe('profile returns CSV — classification provenance', () => {
  it('reads producer versus derived from per-source metadata, not from the code', () => {
    const b = new ProfileSectionBuilder();
    const cls: ProfileSourceChannels = { classification: new Uint8Array([2]) };
    b.beginSource(0, cls, 1);
    b.push(0, 0, 1, 0);
    b.beginSource(1, cls, 1);
    b.push(0, 1, 2, 0);
    const { csv } = buildProfileReturnsCsv(
      b.finish(),
      baseOptions([
        { slot: 0, layerId: 'L0', layerName: 'producer.laz', classificationSource: 'source' },
        { slot: 1, layerId: 'L1', layerName: 'guessed.laz', classificationSource: 'derived' },
      ]),
    );
    const { header, body } = rowsOf(csv);
    // Identical ASPRS code 2 in both rows; the provenance still differs.
    expect(col(header, body, 'classification')).toEqual(['2', '2']);
    expect(col(header, body, 'classification_source')).toEqual(['source', 'derived']);
  });

  it('omits the column when no layer declares a provenance', () => {
    const b = new ProfileSectionBuilder();
    b.beginSource(0, { classification: new Uint8Array([2]) }, 1);
    b.push(0, 0, 1, 0);
    const { csv } = buildProfileReturnsCsv(
      b.finish(),
      baseOptions([{ slot: 0, layerId: 'L0', layerName: 'a.las' }]),
    );
    const { header } = rowsOf(csv);
    expect(header).toContain('classification');
    expect(header).not.toContain('classification_source');
  });
});

describe('profile returns CSV — receipt', () => {
  it('records the measurement context and takes the timestamp as a parameter', () => {
    const { receipt, receiptJson } = buildProfileReturnsCsv(mixedSection(), {
      ...baseOptions(MIXED_SOURCES),
      crsName: 'NAD83 / UTM zone 13N (EPSG:26913)',
      displayedIndices: new Uint32Array([0, 1]),
      visualLodInUse: true,
    });
    expect(receipt.measurement).toEqual({ id: 'm-1', name: 'Section A' });
    expect(receipt.endpoints.a).toEqual([0, 0, 0]);
    expect(receipt.endpoints.b).toEqual([10, 0, 0]);
    expect(receipt.up).toEqual([0, 0, 1]); // normalised from [0,0,2]
    expect(receipt.corridorHalfWidth).toBe(1.5);
    expect(receipt.acceptedCount).toBe(3);
    expect(receipt.displayedCount).toBe(2);
    expect(receipt.visualLodInUse).toBe(true);
    expect(receipt.units).toEqual({
      system: 'metric',
      unitName: 'metre',
      metresPerUnit: 1,
      crs: 'NAD83 / UTM zone 13N (EPSG:26913)',
    });
    expect(receipt.vertical.label).toBe('Elevation');
    expect(receipt.sources.map((s) => [s.layerId, s.classificationSource, s.acceptedCount])).toEqual(
      [
        ['L0', 'source', 2],
        ['L1', 'none', 1],
      ],
    );
    expect(receipt.generatedAt).toBe(AT);
    expect(JSON.parse(receiptJson).generatedAt).toBe(AT);
  });

  it('is byte-identical across builds with the same injected timestamp', () => {
    const a = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    const b = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    expect(b.csv).toBe(a.csv);
    expect(b.receiptJson).toBe(a.receiptJson);
  });

  it('carries the streaming node key when a slot is a streaming node', () => {
    const b = new ProfileSectionBuilder();
    b.beginSource(0, null, 1);
    b.push(0, 0, 1, 0);
    const { csv, receipt } = buildProfileReturnsCsv(
      b.finish(),
      baseOptions([
        { slot: 0, layerId: 'L0', layerName: 'copc', streamingNodeKey: '3-1-2-0' },
      ]),
    );
    const { header, body } = rowsOf(csv);
    expect(col(header, body, 'streaming_node_key')).toEqual(['3-1-2-0']);
    expect(receipt.sources[0]!.streamingNodeKey).toBe('3-1-2-0');
  });

  it('omits the station column when no metres-per-unit scale is known', () => {
    const opts = baseOptions(MIXED_SOURCES);
    const withScale = buildProfileReturnsCsv(mixedSection(), opts);
    const withoutScale = buildProfileReturnsCsv(mixedSection(), {
      ...opts,
      unitToMetres: undefined,
    });
    expect(rowsOf(withScale.csv).header).toContain('station');
    expect(col(rowsOf(withScale.csv).header, rowsOf(withScale.csv).body, 'station')).toEqual([
      '0+001.00',
      '0+002.00',
      '0+003.00',
    ]);
    expect(rowsOf(withoutScale.csv).header).not.toContain('station');
    expect(withoutScale.receipt.units.metresPerUnit).toBeNull();
  });
});

describe('profile returns CSV — hostile text', () => {
  for (const hostile of ['=HYPERLINK("http://x","c")', '+1+1', '-2+3', '@SUM(A1)']) {
    it(`neutralises a layer name starting ${hostile[0]}`, () => {
      const b = new ProfileSectionBuilder();
      b.beginSource(0, null, 1);
      b.push(0, 0, 1, 0);
      const { csv } = buildProfileReturnsCsv(
        b.finish(),
        baseOptions([{ slot: 0, layerId: 'L0', layerName: hostile }]),
      );
      const { header, body } = rowsOf(csv);
      const raw = csv.split('\n')[1]!;
      // Force-quoted in the bytes, and the parsed value is prefixed so no
      // spreadsheet evaluates it as a formula.
      expect(raw).toContain(`"'${hostile.replaceAll('"', '""')}"`);
      expect(col(header, body, 'layer_name')).toEqual([`'${hostile}`]);
    });
  }

  it('leaves a negative number a plain number', () => {
    const { csv } = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    const { header, body } = rowsOf(csv);
    expect(col(header, body, 'lateral_offset')).toEqual(['-0.500', '0.250', '0.750']);
    expect(csv).not.toContain("'-0.500");
  });

  it('round-trips a layer name holding a comma, a double quote and a newline', () => {
    const nasty = 'Site, "north"\nblock';
    const b = new ProfileSectionBuilder();
    b.beginSource(0, { intensity: new Uint16Array([0, 3]) }, 2);
    b.push(0, 0, 1, 0);
    b.push(1, 5, 2, 0);
    const { csv } = buildProfileReturnsCsv(
      b.finish(),
      baseOptions([{ slot: 0, layerId: 'L,0', layerName: nasty }]),
    );
    const { header, body } = rowsOf(csv);
    expect(body).toHaveLength(2);
    expect(col(header, body, 'layer_name')).toEqual([nasty, nasty]);
    expect(col(header, body, 'layer_id')).toEqual(['L,0', 'L,0']);
    // The embedded newline must not have split the row: the trailing columns
    // still line up.
    expect(col(header, body, 'intensity')).toEqual(['0', '3']);
  });
});

describe('profile returns CSV — shape', () => {
  it('puts the header first, uses LF, and ends with a newline', () => {
    const { csv } = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    expect(csv.startsWith('station,chainage,elevation,lateral_offset,')).toBe(true);
    expect(csv.endsWith('\n')).toBe(true);
    expect(csv).not.toContain('\r');
    // A CSV carries no comment lines; the receipt is the sidecar.
    expect(csv.startsWith('#')).toBe(false);
  });

  it('gives every row the header cell count', () => {
    const { csv } = buildProfileReturnsCsv(mixedSection(), baseOptions(MIXED_SOURCES));
    const { header, body } = rowsOf(csv);
    for (const r of body) expect(r).toHaveLength(header.length);
  });

  it('writes an empty body for an empty section', () => {
    const { csv, receipt } = buildProfileReturnsCsv(
      new ProfileSectionBuilder().finish(),
      baseOptions([]),
    );
    expect(rowsOf(csv).body).toHaveLength(0);
    expect(receipt.acceptedCount).toBe(0);
  });
});
