#!/usr/bin/env node
/**
 * make-copc-fixture.mjs: regenerates `tests/fixtures/copc/terrain-access-utm.copc.laz`.
 *
 * The streaming e2e specs need a real COPC file with real LAZ chunks, small
 * enough to commit. This converts the in-repo `tests/fixtures/terrain-access-utm.las`
 * (900 project-made points, UTM 13N; see scripts/gen-terrain-access-fixture.ts)
 * with PDAL's `writers.copc`. No third-party data goes in.
 *
 * PDAL stamps the header with today's creation day and year, which would make
 * every run produce different bytes. Those two fields are pinned afterwards, so
 * the same PDAL version writes a byte-identical file on any day.
 *
 * Needs `pdal` on PATH (checked with PDAL 2.10.2).
 * Run: node scripts/make-copc-fixture.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../tests/fixtures/terrain-access-utm.las', import.meta.url));
const out = fileURLToPath(new URL('../tests/fixtures/copc/terrain-access-utm.copc.laz', import.meta.url));

execFileSync('pdal', ['translate', src, out, '--writer', 'writers.copc'], { stdio: 'inherit' });

// LAS 1.4 public header: file creation day of year (u16) at byte 90, year (u16) at 92.
const bytes = readFileSync(out);
bytes.writeUInt16LE(1, 90);
bytes.writeUInt16LE(2026, 92);
writeFileSync(out, bytes);
console.log(`wrote ${out} (${bytes.length} bytes)`);
