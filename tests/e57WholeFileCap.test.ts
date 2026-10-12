/**
 * e57WholeFileCap.test.ts
 *
 * How the 1 GiB whole-file cap meets E57.
 *
 * E57's preflight reads only the XML page run by slice, but its decode does
 * not: `loadFile` reads the whole E57 into one ArrayBuffer and transfers it to
 * the worker. So E57 is a whole-file reader (pinned in the last block; if E57
 * moves to a ranged read, that test fails and E57 should leave the cap).
 *
 * E57's own decode ceiling is the stricter limit. The plan holds two copies of
 * the file plus a 200 MB allowance inside 2,000,000,000 bytes, so no E57 of
 * 900 MB or more ever fits, on any device. An E57 between 1 GiB and 2 GB was
 * therefore refused before the cap existed, and still is, by the same
 * `e57Refusal` with the same message: `loadFile` checks E57 before the cap.
 *
 * The fixture is the committed 2 KB synthetic E57 behind a `File` stand-in that
 * claims a larger size. "Passed every refusal" is observed without allocating
 * that size: the signal is aborted in `onPreload`, so a load that gets past the
 * refusals stops at the first check inside the whole-file read.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadFile, LoadCancelledError, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import {
  E57_DECODE_CEILING_BYTES,
  MAX_WHOLE_FILE_BYTES,
  e57TooLargeMessage,
  planE57Decode,
} from '../src/io/loadPlan';
import type { E57DecodePlan } from '../src/io/loadPlan';
import { LoadError } from '../src/io/loadErrors';
import { preflightE57 } from '../src/io/e57/preflight';

const BYTES = new Uint8Array(readFileSync(new URL('./fixtures/synthetic.e57', import.meta.url)));
const DECLARED = preflightE57(BYTES.slice().buffer as ArrayBuffer);
const DESKTOP_GB = 8;
const BETWEEN_CAP_AND_E57_CEILING = 1_500_000_000;
/** Larger than the 16 KiB head slice and the XML page run: a body read. */
const BODY_READ_MIN = 1 << 20;

function fakeE57(size: number): { file: File; bodyReads: () => number } {
  let reads = 0;
  const file = {
    name: 'scan.e57',
    size,
    slice: (start = 0, end = size) => ({
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        if (end - start >= BODY_READ_MIN) reads++;
        return BYTES.slice(start, Math.min(end, BYTES.byteLength)).buffer as ArrayBuffer;
      },
    }),
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      reads++;
      return BYTES.slice().buffer as ArrayBuffer;
    },
  } as unknown as File;
  return { file, bodyReads: () => reads };
}

function e57Plan(size: number, deviceMemoryGB = DESKTOP_GB): E57DecodePlan {
  return planE57Decode({
    sourceCount: DECLARED.recordCount,
    fileBytes: size,
    decodeBytesPerRecord: DECLARED.decodeBytesPerRecord,
    structuredGridBytes: DECLARED.structuredGridBytes,
    attributes: DECLARED.attributes,
    isMobile: false,
    deviceMemoryGB,
  });
}

/** Load with the signal aborted once the preflight is done, so no body is read. */
async function loadUntilRead(file: File): Promise<unknown> {
  const ctl = new AbortController();
  return loadFile(file, { onPreload: () => ctl.abort() }, { deviceMemoryGB: DESKTOP_GB, signal: ctl.signal })
    .catch((e: unknown) => e);
}

afterEach(() => __setParseWorkerFactoryForTests(undefined));

describe('the E57 decode ceiling is stricter than the whole-file cap', () => {
  it('no E57 at or over 900 MB fits, whatever the device reports', () => {
    expect(E57_DECODE_CEILING_BYTES).toBe(2_000_000_000);
    expect(e57Plan(900_000_000, 64).fits).toBe(false);
    expect(e57Plan(MAX_WHOLE_FILE_BYTES, 64).fits).toBe(false);
  });

  it('a small E57 still fits (the plan can say yes)', () => {
    expect(e57Plan(60_000_000).fits).toBe(true);
  });
});

describe('an E57 between 1 GiB and 2 GB is refused exactly as before the cap', () => {
  it('by e57Refusal with its own message, before its body is read', async () => {
    const { file, bodyReads } = fakeE57(BETWEEN_CAP_AND_E57_CEILING);
    const err = await loadUntilRead(file);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('memory-constraint');
    expect((err as LoadError).message).toBe(e57TooLargeMessage('scan.e57', e57Plan(BETWEEN_CAP_AND_E57_CEILING)));
    expect(bodyReads()).toBe(0);
  });

  it('an E57 that fits passes every refusal and reaches the whole-file read', async () => {
    const { file, bodyReads } = fakeE57(60_000_000);
    expect(await loadUntilRead(file)).toBeInstanceOf(LoadCancelledError);
    expect(bodyReads()).toBe(0);
  });
});

describe('the premise: the E57 load reads the whole file into one buffer', () => {
  it('posts a transferred buffer to the worker, not the File', async () => {
    const posted: Record<string, unknown>[] = [];
    const worker = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      onerror: null,
      postMessage(msg: Record<string, unknown>) {
        posted.push(msg);
        setTimeout(() => worker.onmessage?.({
          data: {
            type: 'done',
            cloud: { positions: Float32Array.from([0, 0, 0]), origin: [0, 0, 0], sourceFormat: 'e57', name: 'scan.e57' },
            originalPointCount: 1,
            downsampled: false,
            telemetry: {},
          },
        } as MessageEvent), 0);
      },
      terminate() {},
    };
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const { file } = fakeE57(BYTES.byteLength);
    await loadFile(file, {}, { deviceMemoryGB: DESKTOP_GB });
    expect(posted).toHaveLength(1);
    expect(posted[0].buffer).toBeInstanceOf(ArrayBuffer);
    expect(posted[0].file).toBeUndefined();
  });
});
