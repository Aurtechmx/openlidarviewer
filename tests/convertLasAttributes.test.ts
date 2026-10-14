/**
 * convertLasAttributes.test.ts
 *
 * The converter decodes at full resolution with no load plan. That decode must
 * still allocate scan angle, user data, scanner channel, scan direction and
 * edge-of-flight-line so the LAS writers can carry them into the output.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { decodeFullViaWorker, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import { parseBuffer } from '../src/io/parseBuffer';

const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'withheld-flags.las'));
const fixtureBuf = (): ArrayBuffer =>
  FIXTURE.buffer.slice(FIXTURE.byteOffset, FIXTURE.byteOffset + FIXTURE.byteLength) as ArrayBuffer;

/** A fake parse worker that runs the real `parseBuffer` on the request it receives. */
class ParsingFakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: unknown): void {
    const r = message as {
      buffer: ArrayBuffer;
      format: 'las';
      name: string;
      budget: number;
      plan?: undefined;
      pointSemantics?: boolean;
    };
    void parseBuffer(r.buffer, r.format, r.name, r.budget, r.plan, undefined, undefined, r.pointSemantics).then(
      (res) =>
        this.onmessage?.({
          data: {
            type: 'done',
            cloud: res.cloud,
            originalPointCount: res.originalPointCount,
            downsampled: res.downsampled,
            telemetry: {},
          },
        } as MessageEvent),
    );
  }
  terminate(): void {
    /* no-op */
  }
}

describe('plan-less full-resolution LAS decode carries the point attributes', () => {
  afterEach(() => __setParseWorkerFactoryForTests(undefined));

  it('parseBuffer without a plan allocates the five channels when pointSemantics is on', async () => {
    const { cloud } = await parseBuffer(
      fixtureBuf(), 'las', 'withheld-flags.las', Number.MAX_SAFE_INTEGER,
      undefined, undefined, undefined, true,
    );
    expect(cloud.scanAngle).toBeInstanceOf(Float32Array);
    expect(cloud.userData).toBeInstanceOf(Uint8Array);
    expect(cloud.scannerChannel).toBeInstanceOf(Uint8Array);
    expect(cloud.scanDirection).toBeInstanceOf(Uint8Array);
    expect(cloud.edgeOfFlightLine).toBeInstanceOf(Uint8Array);
    expect(cloud.scanAngle!.length).toBe(cloud.pointCount);
  });

  it('parseBuffer without a plan leaves them undefined when pointSemantics is off', async () => {
    const { cloud } = await parseBuffer(fixtureBuf(), 'las', 'withheld-flags.las');
    expect(cloud.scanAngle).toBeUndefined();
    expect(cloud.edgeOfFlightLine).toBeUndefined();
  });

  it('decodeFullViaWorker returns the channels', async () => {
    __setParseWorkerFactoryForTests(() => new ParsingFakeWorker() as unknown as Worker);
    const cloud = await decodeFullViaWorker(fixtureBuf(), 'withheld-flags.las', undefined, true);
    expect(cloud.scanAngle).toBeInstanceOf(Float32Array);
    expect(cloud.userData).toBeInstanceOf(Uint8Array);
    expect(cloud.scannerChannel).toBeInstanceOf(Uint8Array);
    expect(cloud.scanDirection).toBeInstanceOf(Uint8Array);
    expect(cloud.edgeOfFlightLine).toBeInstanceOf(Uint8Array);
  });
});
