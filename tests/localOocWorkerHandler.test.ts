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
  const h: OocWorkerHost = {
    post,
    runBuild,
    getController: () => controller,
    setController: (c) => {
      controller = c;
    },
    ...over,
  };
  return { h, post, runBuild, getController: () => controller };
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
