/**
 * e57PreflightGuard.test.ts
 *
 * The E57 memory guard at the three seams where it has to hold: before the file
 * body is read, across the thread boundary, and when the preflight itself
 * fails.
 *
 * WHAT WAS BROKEN.
 *
 * 1. `loadFile` ran the preflight, built the preload summary, then read the
 *    whole file into one ArrayBuffer and posted it to the worker, which
 *    re-planned and only then refused. A 600 MB E57 already known not to fit
 *    was materialised in full first, on the device least able to hold it.
 * 2. The worker request carried the LAS/LAZ `plan` and no E57 plan, so
 *    `loadE57` planned again from `readDeviceHints()`. `matchMedia` is declared
 *    on `Window` and does not exist in a worker global scope, so the worker
 *    reads every device as a desktop: `memoryCeilingBytes` then takes 0.6 of
 *    reported memory instead of a phone's 0.4, and the decode can apply a
 *    different stride, or none, from the one the preload summary named.
 * 3. Both preflight call sites caught and continued: `buildE57Preflight`
 *    returned undefined and `loadE57` set `plan = undefined`, after which
 *    `plan?.stride ?? 1` produced a FULL decode. A preflight failure switched
 *    the guard off on exactly the files it exists for.
 *
 * The fixture is the committed 2 KB synthetic E57 (8 records, 6 of them valid)
 * carried by a `File` stand-in that CLAIMS a 60 MB size. The declaration is
 * what the plan reads and the size is one of its inputs, so a small fixture can
 * stand in for a large file without allocating one, and the whole-file read is
 * a single `arrayBuffer()` call the stand-in counts.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadFile, fileMetadata, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import { loadE57 } from '../src/io/loadE57';
import { planE57Decode } from '../src/io/loadPlan';
import type { E57DecodePlan } from '../src/io/loadPlan';
import { LoadError } from '../src/io/loadErrors';
import { preflightE57 } from '../src/io/e57/preflight';

/** Flips `preflightE57` into failure for the fail-closed case, and back. */
const guardState = vi.hoisted(() => ({ preflightThrows: false }));

vi.mock('../src/io/e57/preflight', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/io/e57/preflight')>();
  return {
    ...real,
    preflightE57: (buffer: ArrayBuffer) => {
      if (guardState.preflightThrows) throw new Error('simulated preflight defect');
      return real.preflightE57(buffer);
    },
  };
});

const FIXTURE = readFileSync(new URL('./fixtures/synthetic.e57', import.meta.url));
const BYTES = new Uint8Array(FIXTURE);

/** Bytes of the same file with one XML-page byte flipped, so its CRC-32C fails. */
function corruptedBytes(): Uint8Array {
  const copy = new Uint8Array(BYTES);
  copy[200] ^= 0xff;
  return copy;
}

/** Size the stand-in claims. Under the 64 MiB chunk threshold, so the body read
 * is one `arrayBuffer()` call. */
const CLAIMED_SIZE = 60_000_000;

/** Device memory that leaves the two file copies and the resident allowance short. */
const REFUSING_GB = 0.45;
/** Device memory with room for the whole decode on either device class. */
const ROOMY_GB = 4;
/** Device memory a phone refuses at and a desktop accepts at. */
const DIVERGING_GB = 0.7;

/** The declared facts the plans below are built from. */
const DECLARED = preflightE57(
  BYTES.buffer.slice(BYTES.byteOffset, BYTES.byteOffset + BYTES.byteLength) as ArrayBuffer,
);

function planFor(deviceMemoryGB: number, isMobile: boolean): E57DecodePlan {
  return planE57Decode({
    sourceCount: DECLARED.recordCount,
    fileBytes: CLAIMED_SIZE,
    decodeBytesPerRecord: DECLARED.decodeBytesPerRecord,
    structuredGridBytes: DECLARED.structuredGridBytes,
    attributes: DECLARED.attributes,
    isMobile,
    deviceMemoryGB,
  });
}

/** A `File` stand-in that serves real bytes, claims a size, and counts body reads. */
function fakeE57File(
  bytes: Uint8Array,
  name: string,
  size: number,
): { file: File; bodyReads: () => number } {
  let bodyReads = 0;
  const file = {
    name,
    size,
    slice: (start = 0, end = bytes.byteLength) => ({
      arrayBuffer: async (): Promise<ArrayBuffer> =>
        bytes.slice(start, Math.min(end, bytes.byteLength)).buffer as ArrayBuffer,
    }),
    arrayBuffer: async (): Promise<ArrayBuffer> => {
      bodyReads++;
      return bytes.slice().buffer as ArrayBuffer;
    },
  } as unknown as File;
  return { file, bodyReads: () => bodyReads };
}

/** A parse worker that records every request and answers each with a `done`. */
class RecordingWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Record<string, unknown>[] = [];

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    this.posted.push(message as Record<string, unknown>);
    setTimeout(() => {
      this.onmessage?.({
        data: {
          type: 'done',
          cloud: {
            positions: Float32Array.from([0, 0, 0]),
            origin: [0, 0, 0],
            sourceFormat: 'e57',
            name: 'synthetic.e57',
          },
          originalPointCount: 1,
          downsampled: false,
          telemetry: {},
        },
      } as MessageEvent);
    }, 0);
  }
  terminate(): void {}
}

afterEach(() => {
  __setParseWorkerFactoryForTests(undefined);
  guardState.preflightThrows = false;
});

describe('the fixture and the device figures', () => {
  // Asserted through `planE57Decode` first so a failure below is unambiguous:
  // the numbers are wrong, not the wiring that acts on them.
  it('declares eight records and four decode columns', () => {
    expect(DECLARED.recordCount).toBe(8);
    expect(DECLARED.decodeBytesPerRecord).toBe(4 * 8);
  });

  it('does not fit on the refusing device', () => {
    expect(planFor(REFUSING_GB, false).fits).toBe(false);
  });

  it('fits on the roomy device', () => {
    expect(planFor(ROOMY_GB, false).fits).toBe(true);
  });

  it('a phone and a desktop reach opposite verdicts on the same file', () => {
    // The consequence of a worker planning for itself: same declaration, same
    // reported memory, opposite answers.
    expect(planFor(DIVERGING_GB, true).fits).toBe(false);
    expect(planFor(DIVERGING_GB, false).fits).toBe(true);
  });
});

describe('loadFile refuses an E57 before reading its body', () => {
  it('never reads the file when the plan does not fit', async () => {
    const worker = new RecordingWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const { file, bodyReads } = fakeE57File(BYTES, 'too-big.e57', CLAIMED_SIZE);

    const err = await loadFile(file, {}, { deviceMemoryGB: REFUSING_GB }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('memory-constraint');
    expect((err as LoadError).message).toContain('too large for this device');
    // The claim under test: the body was never pulled into memory, and the
    // worker was never asked to decode it.
    expect(bodyReads()).toBe(0);
    expect(worker.posted).toHaveLength(0);
  });

  it('reads the body for the same file when the plan fits', async () => {
    // The counter above has to be capable of moving, or the assertion is empty.
    const worker = new RecordingWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const { file, bodyReads } = fakeE57File(BYTES, 'ok.e57', CLAIMED_SIZE);

    await loadFile(file, {}, { deviceMemoryGB: ROOMY_GB });

    expect(bodyReads()).toBe(1);
    expect(worker.posted).toHaveLength(1);
  });

  it('refuses before the read when the declaration will not parse', async () => {
    const worker = new RecordingWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const { file, bodyReads } = fakeE57File(corruptedBytes(), 'corrupt.e57', CLAIMED_SIZE);

    const err = await loadFile(file, {}, { deviceMemoryGB: ROOMY_GB }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
    expect((err as LoadError).message).toMatch(/CRC-32C/);
    expect(bodyReads()).toBe(0);
    expect(worker.posted).toHaveLength(0);
  });

  it('states the unreadable declaration in the metadata without throwing', async () => {
    // `fileMetadata` is the cheap probe behind the preload summary, so it
    // reports the condition instead of raising it.
    const { file } = fakeE57File(corruptedBytes(), 'corrupt.e57', CLAIMED_SIZE);
    const meta = await fileMetadata(file, { deviceMemoryGB: ROOMY_GB });
    expect(meta.format).toBe('e57');
    expect(meta.warning).toMatch(/declaration unreadable/i);
    expect(meta.warning).toMatch(/refused/i);
  });
});

describe('the worker decodes to the plan the main thread built', () => {
  it('posts that plan with the request', async () => {
    const worker = new RecordingWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const { file } = fakeE57File(BYTES, 'phone.e57', CLAIMED_SIZE);

    await loadFile(file, {}, { isMobile: true, deviceMemoryGB: ROOMY_GB });

    expect(worker.posted).toHaveLength(1);
    const posted = worker.posted[0].e57Plan as E57DecodePlan;
    expect(posted).toEqual(planFor(ROOMY_GB, true));
    // And it is not the plan the worker would have built for itself, which is
    // the desktop one: no `matchMedia` there to report the phone.
    expect(posted).not.toEqual(planFor(ROOMY_GB, false));
    expect(posted.ceilingBytes).toBeLessThan(planFor(ROOMY_GB, false).ceilingBytes);
  });

  it('applies a supplied stride instead of planning again', async () => {
    const buffer = BYTES.slice().buffer as ArrayBuffer;
    const supplied: E57DecodePlan = {
      mode: 'stride',
      stride: 2,
      sourceCount: 8,
      decodedCount: 4,
      memoryEstimateBytes: 400_000_000,
      fullDecodeEstimateBytes: 800_000_000,
      ceilingBytes: 600_000_000,
      fits: true,
    };

    const strided = await loadE57(buffer, 'supplied.e57', { plan: supplied });
    // Every device signal available in this runtime says a full decode fits,
    // so a loader that re-planned would read all 8 records.
    const unplanned = await loadE57(BYTES.slice().buffer as ArrayBuffer, 'unplanned.e57');

    expect(unplanned.loadStride).toBe(1);
    expect(unplanned.pointCount).toBe(6);
    expect(strided.loadStride).toBe(2);
    expect(strided.pointCount).toBeLessThan(unplanned.pointCount);
    expect(strided.declaredPointCount).toBe(8);
    expect(strided.metadata?.loadWarnings?.[0]).toContain('Read as a sample');
  });
});

describe('loadE57 fails closed when its own preflight throws', () => {
  it('decodes the fixture while the preflight works', async () => {
    // The control: this buffer is decodable, so a refusal below comes from the
    // guard and not from the file.
    const cloud = await loadE57(BYTES.slice().buffer as ArrayBuffer, 'control.e57');
    expect(cloud.pointCount).toBe(6);
  });

  it('refuses the same buffer when the preflight fails', async () => {
    guardState.preflightThrows = true;
    const err = await loadE57(BYTES.slice().buffer as ArrayBuffer, 'noplan.e57').catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
    expect((err as LoadError).message).toContain('simulated preflight defect');
    expect((err as LoadError).message).toMatch(/refused/i);
  });
});
