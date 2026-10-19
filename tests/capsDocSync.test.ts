/**
 * capsDocSync.test.ts
 *
 * The fixed caps on untrusted input are stated in the release limits document
 * and the release notes. Each document must carry the number the code enforces,
 * so raising or lowering a cap without updating them fails here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_FRAME_LAYERS } from '../src/io/sessionFrame';
import { MAX_SESSION_MEASUREMENTS } from '../src/io/session';
import { MAX_SESSION_BYTES } from '../src/app/sessionIo';
import { MAX_COPC_NODE_BYTES } from '../src/io/copc/copcHierarchy';

const doc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../docs/releases/${name}`, import.meta.url)), 'utf8').replace(/\s+/g, ' ');
const MIB = 1024 * 1024;

describe('documented caps match the code', () => {
  const limits = doc('KNOWN_LIMITATIONS_v0.7.0.md');
  const notes = doc('RELEASE_NOTES_v0.7.0.md');

  it('states the session caps', () => {
    for (const text of [limits, notes]) {
      expect(text).toContain(`${MAX_FRAME_LAYERS} frame layers`);
      expect(text).toContain(`${MAX_SESSION_MEASUREMENTS.toLocaleString('en-US')} measurements`);
      expect(text).toContain(`${MAX_SESSION_BYTES / MIB} MiB`);
    }
    // The values themselves, so a change shows in this file too.
    expect([MAX_FRAME_LAYERS, MAX_SESSION_MEASUREMENTS, MAX_SESSION_BYTES]).toEqual([512, 20_000, 64 * MIB]);
  });

  it('states the COPC data-node cap', () => {
    expect(limits).toContain(`data node larger than ${MAX_COPC_NODE_BYTES / MIB} MiB is dropped`);
    expect(MAX_COPC_NODE_BYTES / MIB).toBe(128);
  });
});
