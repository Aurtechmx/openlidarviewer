/**
 * E57 colour and intensity limits (ASTM E2807).
 *
 * Colour is normalised per channel, (v − min_c) / (max_c − min_c) · 255, from
 * the declared colorLimits. Without colorLimits, the colour fields' declared
 * Integer minimum/maximum stand in, so 16-bit colour is not clipped at 255.
 * intensityLimits are read with their minimum.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseXml } from '../src/io/e57/xml';
import { readE57Document, type E57ColorLimits } from '../src/io/e57/schema';
import type { E57ScanData, E57ParseResult } from '../src/io/e57/parseE57';
import { parseE57 } from '../src/io/e57/parseE57';
import { loadE57 } from '../src/io/loadE57';
import type { E57DecodePlan } from '../src/io/loadPlan';

vi.mock('../src/io/e57/parseE57', () => ({ parseE57: vi.fn() }));
const mockedParse = vi.mocked(parseE57);

const READ_EVERY_RECORD: E57DecodePlan = {
  mode: 'all',
  stride: 1,
  sourceCount: 0,
  decodedCount: 0,
  memoryEstimateBytes: 0,
  fullDecodeEstimateBytes: 0,
  ceilingBytes: 0,
  fits: true,
};

function xml(scanLimits: string, colorMax: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<e57Root type="Structure" xmlns="http://www.astm.org/COMMIT/E57/2010-e57-v1.0">
  <formatName type="String"><![CDATA[ASTM E57 3D Imaging Data File]]></formatName>
  <guid type="String"><![CDATA[{root}]]></guid>
  <data3D type="Vector" allowHeterogeneousChildren="1">
    <vectorChild type="Structure">
      <guid type="String"><![CDATA[{scan}]]></guid>
      ${scanLimits}
      <points type="CompressedVector" fileOffset="48" recordCount="1">
        <prototype type="Structure">
          <cartesianX type="Float" precision="single"/>
          <cartesianY type="Float" precision="single"/>
          <cartesianZ type="Float" precision="single"/>
          <colorRed type="Integer" minimum="0" maximum="${colorMax}"/>
          <colorGreen type="Integer" minimum="0" maximum="${colorMax}"/>
          <colorBlue type="Integer" minimum="0" maximum="${colorMax}"/>
        </prototype>
        <codecs type="Vector"/>
      </points>
    </vectorChild>
  </data3D>
</e57Root>`;
}

const readScan = (s: string) => readE57Document(parseXml(s)).scans[0];

describe('E57 schema: limits', () => {
  it('reads per-channel colorLimits with their minimums', () => {
    const scan = readScan(
      xml(
        `<colorLimits type="Structure">
          <colorRedMinimum type="Integer">10</colorRedMinimum>
          <colorRedMaximum type="Integer">265</colorRedMaximum>
          <colorGreenMinimum type="Integer"/>
          <colorGreenMaximum type="Integer">1023</colorGreenMaximum>
          <colorBlueMinimum type="Integer">100</colorBlueMinimum>
          <colorBlueMaximum type="Integer">355</colorBlueMaximum>
        </colorLimits>`,
        65535,
      ),
    );
    expect(scan.colorLimits).toEqual({
      red: { minimum: 10, maximum: 265 },
      green: { minimum: 0, maximum: 1023 },
      blue: { minimum: 100, maximum: 355 },
    });
  });

  it('falls back to the colour fields’ declared Integer range without colorLimits', () => {
    const scan = readScan(xml('', 65535));
    const r = { minimum: 0, maximum: 65535 };
    expect(scan.colorLimits).toEqual({ red: r, green: r, blue: r });
  });

  it('reads intensityMinimum as well as intensityMaximum', () => {
    const scan = readScan(
      xml(
        `<intensityLimits type="Structure">
          <intensityMinimum type="Integer">-2048</intensityMinimum>
          <intensityMaximum type="Integer">2047</intensityMaximum>
        </intensityLimits>`,
        255,
      ),
    );
    expect(scan.intensityLimits).toEqual({ minimum: -2048, maximum: 2047 });
  });
});

function colorScan(rgb: number[][], colorLimits: E57ColorLimits | null): E57ScanData {
  return {
    name: 'scan',
    guid: 'guid',
    recordCount: rgb.length,
    declaredRecordCount: rgb.length,
    columns: {
      cartesianX: Float64Array.from(rgb.map((_, i) => i)),
      cartesianY: Float64Array.from(rgb.map(() => 0)),
      cartesianZ: Float64Array.from(rgb.map(() => 0)),
      colorRed: Float64Array.from(rgb.map((c) => c[0])),
      colorGreen: Float64Array.from(rgb.map((c) => c[1])),
      colorBlue: Float64Array.from(rgb.map((c) => c[2])),
    },
    fields: [],
    pose: null,
    colorLimits,
    intensityLimits: null,
  };
}

function result(scan: E57ScanData): E57ParseResult {
  return {
    scans: [scan],
    metadata: { formatName: 'ASTM E57 3D Imaging Data File', guid: 'g', library: 't', creationDateTime: null },
    sourceMetadata: null,
    warnings: [],
  };
}

beforeEach(() => mockedParse.mockReset());

describe('loadE57: colour normalisation', () => {
  it('subtracts a nonzero colour minimum', async () => {
    const r = { minimum: 100, maximum: 355 };
    mockedParse.mockReturnValue(result(colorScan([[100, 100, 100], [355, 227, 355]], { red: r, green: r, blue: r })));
    const cloud = await loadE57(new ArrayBuffer(0), 'min.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.colors!]).toEqual([0, 0, 0, 255, 127, 255]);
  });

  it('normalises each channel by its own limits', async () => {
    mockedParse.mockReturnValue(
      result(
        colorScan([[255, 1023, 65535]], {
          red: { minimum: 0, maximum: 255 },
          green: { minimum: 0, maximum: 1023 },
          blue: { minimum: 0, maximum: 65535 },
        }),
      ),
    );
    const cloud = await loadE57(new ArrayBuffer(0), 'per-channel.e57', { plan: READ_EVERY_RECORD });
    // A merged maximum (65535) would have read red 1 and green 4.
    expect([...cloud.colors!]).toEqual([255, 255, 255]);
  });

  it('16-bit colour without colorLimits uses the field range and is not clipped', async () => {
    const xmlScan = readScan(xml('', 65535));
    mockedParse.mockReturnValue(result(colorScan([[65535, 32768, 0]], xmlScan.colorLimits)));
    const cloud = await loadE57(new ArrayBuffer(0), 'rgb16.e57', { plan: READ_EVERY_RECORD });
    expect([...cloud.colors!]).toEqual([255, 128, 0]);
  });
});
