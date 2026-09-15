/**
 * localOocWorkerHandler.test.ts — the indexer worker validates its messages.
 *
 * A dedicated worker's channel is private to its owner page, but the handler
 * still checks the origin and the message shape before it runs a build. These
 * cases pin both guards: a message from a non-empty origin and a malformed body
 * are each rejected without the build ever starting, and a well-formed owner
 * message dispatches normally.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  handleOocWorkerMessage,
  isOwnerMessage,
  isLocalOocRequestMessage,
  type OocWorkerHost,
} from '../src/io/heavy/worker/localOocWorkerHandler';

function host(over: Partial<OocWorkerHost> = {}) {
  let controller: AbortController | null = null;
  const post = vi.fn();
  const runBuild = vi.fn(async () => ({
    manifestJson: '{}',
    hierarchy: '',
    peakBufferedBytes: 0,
    pointCount: 0,
    storeName: 's',
  }));
  const runDigest = vi.fn<OocWorkerHost['runDigest']>(async () => 'abc123');
  const h: OocWorkerHost = {
    post,
    runBuild,
    runDigest,
    getController: () => controller,
    setController: (c) => {
      controller = c;
    },
    ...over,
  };
  return { h, post, runBuild, runDigest, getController: () => controller };
}

function digestMessage() {
  return {
    type: 'digest' as const,
    file: { name: 'heavy.las', size: 1000 } as unknown as File,
    fileBytes: 1000,
  };
}

/** A minimal structurally-valid build message. */
function buildMessage() {
  return {
    type: 'build' as const,
    file: { name: 'heavy.las', size: 1000 } as unknown as File,
    storeName: 'ooc-heavy',
    options: {},
  };
}

describe('localOocWorkerHandler — origin and shape guards', () => {
  it('ignores a message from a non-empty origin without running the build', async () => {
    const { h, post, runBuild } = host();
    await handleOocWorkerMessage({ origin: 'https://evil.example', data: buildMessage() }, h);
    expect(runBuild).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('rejects a malformed body without running the build', async () => {
    const { h, post, runBuild } = host();
    // A "build" whose required fields are missing is not a valid request.
    await handleOocWorkerMessage({ origin: '', data: { type: 'build' } }, h);
    expect(runBuild).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('malformed') }),
    );
  });

  it('rejects a non-object / unknown-type body without running the build', async () => {
    const { h, runBuild } = host();
    await handleOocWorkerMessage({ origin: '', data: 'not a message' }, h);
    await handleOocWorkerMessage({ origin: '', data: { type: 'frobnicate' } }, h);
    expect(runBuild).not.toHaveBeenCalled();
  });

  it('runs the build for a well-formed owner build message', async () => {
    const { h, post, runBuild } = host();
    await handleOocWorkerMessage({ origin: '', data: buildMessage() }, h);
    expect(runBuild).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'done' }));
  });

  it('aborts the in-flight controller on a valid cancel, and never builds for it', async () => {
    const controller = new AbortController();
    const { h, runBuild } = host({ getController: () => controller });
    await handleOocWorkerMessage({ origin: '', data: { type: 'cancel' } }, h);
    expect(controller.signal.aborted).toBe(true);
    expect(runBuild).not.toHaveBeenCalled();
  });

  it('exposes the guards it is built from', () => {
    expect(isOwnerMessage('')).toBe(true);
    expect(isOwnerMessage('https://x')).toBe(false);
    expect(isLocalOocRequestMessage(buildMessage())).toBe(true);
    expect(isLocalOocRequestMessage({ type: 'build' })).toBe(false);
    expect(isLocalOocRequestMessage({ type: 'cancel' })).toBe(true);
    expect(isLocalOocRequestMessage(null)).toBe(false);
  });
});

/**
 * A digest request is the second thing the worker does for the heavy open. It
 * shares the owner and shape guards with the build, and it takes the same
 * cancel controller, so one Cancel stops whichever of the two is in flight.
 * The hash itself is `sourceContentDigestFromRange`, tested on its own; here
 * only the dispatch, the reply and the error path are pinned.
 */
describe('localOocWorkerHandler — digest requests', () => {
  it('hashes for a well-formed owner digest message and posts the digest', async () => {
    const { h, post, runDigest, runBuild } = host();
    await handleOocWorkerMessage({ origin: '', data: digestMessage() }, h);
    expect(runDigest).toHaveBeenCalledTimes(1);
    expect(runBuild).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ type: 'digest', digest: 'abc123' });
  });

  it('rejects a digest message without a finite byte count or a file', async () => {
    const { h, post, runDigest } = host();
    await handleOocWorkerMessage({ origin: '', data: { ...digestMessage(), fileBytes: Number.NaN } }, h);
    await handleOocWorkerMessage({ origin: '', data: { type: 'digest', fileBytes: 10 } }, h);
    expect(runDigest).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'error', message: expect.stringContaining('malformed') }),
    );
  });

  it('gives the digest a controller a cancel can abort, and clears it after', async () => {
    let seen: AbortSignal | null = null;
    const { h, getController } = host({
      runDigest: async (_m, signal) => {
        seen = signal;
        expect(getController()).not.toBeNull();
        return null;
      },
    });
    await handleOocWorkerMessage({ origin: '', data: digestMessage() }, h);
    expect(seen).not.toBeNull();
    expect(getController()).toBeNull();
  });

  it('posts an error when the hasher throws', async () => {
    const { h, post } = host({ runDigest: async () => { throw new Error('read failed'); } });
    await handleOocWorkerMessage({ origin: '', data: digestMessage() }, h);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'read failed' }));
  });
});
