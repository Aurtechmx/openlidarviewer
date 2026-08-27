/**
 * streamingGpsTimeClaim.test.ts — a streaming cloud is offered a GPS time
 * export field only when its own metadata says it has one.
 *
 * The export panel's summary decides what the writer will emit and what the
 * size estimate counts, so `hasGpsTime` is a statement about the data, not a
 * hint. The shell answered it with a hardcoded `true` for every streaming
 * source, justified by COPC's point format. That justification does not reach
 * the other three: a binary EPT need only declare X/Y/Z, a laszip EPT tile at
 * PDRF 0 or 2 carries no GPS time, and a `pnts` tile has none in any case.
 *
 * These cases pin both directions. A source with no GPS time must not be
 * offered the field, and a source that has one must still be offered it, so
 * the fix cannot degrade into removing the field for everybody.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  streamingHasGpsTime,
  type StreamingSource,
} from '../src/render/streaming/StreamingSource';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { EptStreamingPointCloud } from '../src/render/streaming/EptStreamingPointCloud';
import type { EptTransport } from '../src/render/streaming/EptStreamingPointCloud';
import { TilesetStreamingSource } from '../src/render/streaming/TilesetStreamingSource';
import { parseTileset } from '../src/io/tiles3d/tileset';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';
import { parseEptMetadata } from '../src/io/ept/eptDetect';
import type { EptMetadata, EptSchemaField } from '../src/io/ept/eptTypes';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const EPT_FIXTURE = join(ROOT, 'tests', 'fixtures', 'ept-tiny');

/** The fixture EPT declares X, Y, Z, Intensity, Classification and nothing else. */
function fixtureMetadata(): EptMetadata {
  const parsed = parseEptMetadata(readFileSync(join(EPT_FIXTURE, 'ept.json'), 'utf8'));
  if (!parsed.isEpt) throw new Error('ept-tiny fixture failed to parse');
  return parsed.metadata;
}

/** The same pyramid, written by a producer that DID carry GPS time. */
function metadataWithGpsTime(): EptMetadata {
  const base = fixtureMetadata();
  const gps: EptSchemaField = { name: 'GpsTime', size: 8, type: 'float' };
  return { ...base, schema: [...base.schema, gps] };
}

function eptTransport(): EptTransport {
  const local = (url: string) => join(EPT_FIXTURE, url.replace(/^fixture:\/\/ept-tiny\//, ''));
  return {
    fetchText: async (url) => readFileSync(local(url), 'utf8'),
    fetchBytes: async (url) => {
      const buf = readFileSync(local(url));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

function openEpt(meta: EptMetadata): Promise<EptStreamingPointCloud> {
  return EptStreamingPointCloud.open(meta, 'fixture://ept-tiny/', 'ept-tiny', eptTransport());
}

/** A minimal in-spec tileset: a box volume and one point-tile content. */
const TILESET_DOC = JSON.stringify({
  asset: { version: '1.0' },
  geometricError: 100,
  root: {
    boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
    geometricError: 50,
    refine: 'REPLACE',
    content: { uri: 'r.pnts' },
  },
});

function tilesetSource(): TilesetStreamingSource {
  const transport: TilesetTransport = {
    fetchTilesetJson: async () => '{}',
    fetchTileBytes: async () => new ArrayBuffer(8),
  };
  return new TilesetStreamingSource(
    'tileset-id',
    'tileset',
    'https://host/d/tileset.json',
    transport,
    parseTileset(TILESET_DOC),
  );
}

describe('a streaming source without GPS time is not offered the field', () => {
  it('answers no for an EPT whose schema declares no GpsTime', async () => {
    const cloud = await openEpt(fixtureMetadata());
    expect(cloud.availableColorModes()).not.toContain('rgb');
    expect(
      streamingHasGpsTime(cloud),
      'the ept-tiny schema declares X/Y/Z/Intensity/Classification only, so ' +
        'offering a GPS time field promises a column the writer cannot fill',
    ).toBe(false);
  });

  it('answers no for a 3D Tiles tileset, which has no GPS time in any case', () => {
    expect(streamingHasGpsTime(tilesetSource())).toBe(false);
  });

  it('answers no for a source that has not been taught to answer', () => {
    // The OLV tile store omits the method (see the shrink-only list below).
    // Absent means unknown, and an unknown channel must not be offered.
    const untaught = { kind: 'tiles' } as unknown as StreamingSource;
    expect(streamingHasGpsTime(untaught)).toBe(false);
  });
});

describe('a streaming source that does carry GPS time still reports it', () => {
  it('answers yes for COPC, whose point format is validated as 6/7/8', async () => {
    const fixture = buildSyntheticCopc({
      center: [0, 0, 0],
      halfsize: 128,
      nodes: [{ key: [0, 0, 0, 0], pointCount: 64 }],
    });
    const cloud = await StreamingPointCloud.open(
      new ArrayBufferRangeSource(fixture.buffer),
      'gps.copc.laz',
    );
    expect(cloud.metadata.header.hasGpsTime).toBe(true);
    expect(streamingHasGpsTime(cloud)).toBe(true);
  });

  it('answers yes for an EPT whose schema declares GpsTime', async () => {
    const cloud = await openEpt(metadataWithGpsTime());
    expect(
      streamingHasGpsTime(cloud),
      'a blanket false would strip the field from every EPT that has one',
    ).toBe(true);
  });
});

describe('the shell reads the answer off the source', () => {
  const main = readFileSync(join(SRC, 'main.ts'), 'utf8');

  it('never restates the claim as a literal in the export summary', () => {
    expect(main).not.toMatch(/hasGpsTime:\s*true/);
  });

  it('derives the streaming answer through the source contract', () => {
    expect(main).toMatch(/hasGpsTime:\s*streamingHasGpsTime\(sc\)/);
  });
});

/**
 * Sources that do not implement `hasGpsTime`. The OLV tile store manifest
 * records the answer (`schema.hasGps`) but the file is owned elsewhere, so it
 * currently resolves to the conservative "not offered". Anything ADDED here is
 * a source whose export field is decided by a default rather than by its data,
 * so this list may shrink and never grow.
 */
const WITHOUT_ANSWER: string[] = [];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

function implementers(): { path: string; text: string }[] {
  return tsFiles(SRC)
    .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
    .filter((f) => /class\s+\w+\s+implements\s+StreamingSource\b/.test(f.text))
    .map((f) => ({ path: relative(SRC, f.path).split('\\').join('/'), text: f.text }));
}

describe('every streaming source answers the GPS time question', () => {
  it('finds the implementations at all, so a silent zero cannot pass', () => {
    expect(implementers().length).toBeGreaterThanOrEqual(4);
  });

  it('declares hasGpsTime, unless it is on the shrink-only list', () => {
    const missing = implementers()
      .filter((f) => !/\bhasGpsTime\b/.test(f.text))
      .map((f) => f.path)
      .sort();
    expect(
      missing,
      'a streaming source that cannot say whether it carries GPS time gets a ' +
        'default in front of a user; add the answer rather than the file',
    ).toEqual([...WITHOUT_ANSWER].sort());
  });

  it('keeps the exemption list shrink-only', () => {
    expect(
      WITHOUT_ANSWER.length,
      'the list grew, which means a new source ships an export field decided ' +
        'by a default rather than by its own metadata',
    ).toBeLessThanOrEqual(1);
  });
});
