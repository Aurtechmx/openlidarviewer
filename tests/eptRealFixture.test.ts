/**
 * eptRealFixture.test.ts
 *
 * Validates the EPT detector + parser against a real-shape Entwine
 * manifest committed under `tests/fixtures/ept/tiny/`. Prior tests
 * exercise the parser with handcrafted JSON shaped like Entwine output;
 * this spec consumes a file written in the literal byte-for-byte format
 * Entwine produces, so future schema additions (or our drift away from
 * the spec) surface here first.
 *
 * The fixture is intentionally small (256 declared points, a flat
 * single-node hierarchy with no children) so the test stays fast and
 * the repository stays light. The binary tile data is not committed —
 * the manifest + hierarchy validation here is the value, and the tile
 * decode path is exercised in unit form by `eptLaszipDecode.test.ts` /
 * `EptChunkDecoder.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { detectEptUrl, parseEptMetadata } from '../src/io/ept/eptDetect';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, 'fixtures', 'ept', 'tiny', 'ept.json');
const HIERARCHY_PATH = resolve(
  HERE,
  'fixtures',
  'ept',
  'tiny',
  'ept-hierarchy',
  '0-0-0-0.json',
);

describe('EPT — real Entwine reference fixture', () => {
  it('the manifest file is present', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    expect(text.length).toBeGreaterThan(0);
  });

  it('detectEptUrl matches the canonical `…/ept.json` form', () => {
    expect(detectEptUrl('https://host.example.com/scan/ept.json')).toBe(true);
    expect(detectEptUrl('https://host.example.com/scan/ept.json?token=abc'))
      .toBe(true);
    expect(detectEptUrl('https://host.example.com/scan/ept.json#anchor'))
      .toBe(true);
    expect(detectEptUrl('https://host.example.com/scan.copc.laz')).toBe(false);
    expect(detectEptUrl('https://host.example.com/scan/')).toBe(false);
  });

  it('parseEptMetadata accepts the real-shape v1.0.0 manifest', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const detection = parseEptMetadata(text);
    expect(detection.isEpt).toBe(true);
    if (!detection.isEpt) return;

    expect(detection.metadata.version).toBe('1.0.0');
    expect(detection.metadata.dataType).toBe('laszip');
    expect(detection.metadata.hierarchyType).toBe('json');
    expect(detection.metadata.points).toBe(256);
    expect(detection.metadata.span).toBe(128);
  });

  it('parsed schema carries the required X / Y / Z attributes', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const detection = parseEptMetadata(text);
    if (!detection.isEpt) throw new Error('manifest unexpectedly rejected');

    const names = detection.metadata.schema.map((f) => f.name);
    expect(names).toContain('X');
    expect(names).toContain('Y');
    expect(names).toContain('Z');
  });

  it('parsed schema preserves scale + offset on the coordinate columns', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const detection = parseEptMetadata(text);
    if (!detection.isEpt) throw new Error('manifest unexpectedly rejected');

    for (const axis of ['X', 'Y', 'Z']) {
      const field = detection.metadata.schema.find((f) => f.name === axis);
      expect(field).toBeDefined();
      expect(field?.scale).toBeCloseTo(0.01, 6);
      expect(field?.offset).toBeCloseTo(0.0, 6);
    }
  });

  it('parsed schema includes the inspection extras (intensity / classification / etc.)', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const detection = parseEptMetadata(text);
    if (!detection.isEpt) throw new Error('manifest unexpectedly rejected');

    const names = detection.metadata.schema.map((f) => f.name);
    expect(names).toContain('Intensity');
    expect(names).toContain('Classification');
    expect(names).toContain('GpsTime');
    expect(names).toContain('ReturnNumber');
    expect(names).toContain('NumberOfReturns');
  });

  it('parsed bounds carry both the cubic and conforming arrays', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const detection = parseEptMetadata(text);
    if (!detection.isEpt) throw new Error('manifest unexpectedly rejected');

    expect(detection.metadata.bounds.cubic).toEqual([
      -10, -10, -2.5, 10, 10, 2.5,
    ]);
    expect(detection.metadata.bounds.conforming).toEqual([
      -9.4, -9.1, -2.3, 9.7, 9.8, 2.4,
    ]);
  });

  it('SRS WKT is preserved through parsing', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const detection = parseEptMetadata(text);
    if (!detection.isEpt) throw new Error('manifest unexpectedly rejected');

    expect(detection.metadata.srs).toBeDefined();
    expect(detection.metadata.srs).toContain('WGS 84 / UTM zone 12N');
    expect(detection.metadata.srs).toContain('32612');
  });

  it('the root hierarchy file declares the manifest-claimed point count', () => {
    const text = readFileSync(HIERARCHY_PATH, 'utf8');
    const node = JSON.parse(text) as Record<string, number>;
    // The root key in an EPT hierarchy file maps the node address to a
    // point count. A positive count means "tile data is present"; a
    // negative count means "child hierarchy file exists at this address".
    expect(node['0-0-0-0']).toBe(256);
  });

  it('a malformed-version variant of the same manifest is rejected', () => {
    const text = readFileSync(MANIFEST_PATH, 'utf8');
    const broken = text.replace('"version": "1.0.0"', '"version": "2.5.0"');
    const detection = parseEptMetadata(broken);
    expect(detection.isEpt).toBe(false);
    if (detection.isEpt) return;
    expect(detection.reason).toMatch(/version/i);
  });
});
