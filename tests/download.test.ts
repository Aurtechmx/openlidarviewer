/**
 * download.test.ts — the single browser-download helper.
 *
 * The contract that matters: the object-URL revoke is ALWAYS deferred past the
 * `a.click()`. Revoking synchronously after click is flaky on Safari / iOS and
 * for large blobs (PDF / DEM / batch ZIP), where freeing the URL before the
 * transfer starts can cancel the download mid-flight. These tests stub the
 * minimal DOM / URL surface (the suite runs in the `node` vitest environment,
 * not jsdom) and assert the order: createObjectURL → click → (later) revoke.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerDownload, downloadBytes, downloadText } from '../src/io/download';

interface FakeAnchor {
  href: string;
  download: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

let lastAnchor: FakeAnchor;
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let appendChild: ReturnType<typeof vi.fn>;

const savedDocument = (globalThis as Record<string, unknown>).document;
const savedURL = (globalThis as Record<string, unknown>).URL;

beforeEach(() => {
  vi.useFakeTimers();
  createObjectURL = vi.fn(() => 'blob:fake-url');
  revokeObjectURL = vi.fn();
  appendChild = vi.fn();
  lastAnchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  (globalThis as Record<string, unknown>).document = {
    createElement: vi.fn(() => lastAnchor),
    body: { appendChild },
  };
  (globalThis as Record<string, unknown>).URL = { createObjectURL, revokeObjectURL };
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as Record<string, unknown>).document = savedDocument;
  (globalThis as Record<string, unknown>).URL = savedURL;
});

describe('triggerDownload — deferred-revoke contract', () => {
  it('mints a blob URL, wires the anchor, clicks it, and appends to the DOM', () => {
    const blob = new Blob(['hi'], { type: 'text/plain' });
    triggerDownload(blob, 'note.txt');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(lastAnchor.href).toBe('blob:fake-url');
    expect(lastAnchor.download).toBe('note.txt');
    expect(appendChild).toHaveBeenCalledWith(lastAnchor);
    expect(lastAnchor.click).toHaveBeenCalledTimes(1);
    expect(lastAnchor.remove).toHaveBeenCalledTimes(1);
  });

  it('does NOT revoke the URL synchronously — the regression we guard against', () => {
    triggerDownload(new Blob(['x']), 'a.bin');
    // The whole point: the download must have a tick to start before the URL
    // is freed. A synchronous revoke here is what broke Safari / iOS / large blobs.
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it('revokes the URL only after the deferral timer elapses', () => {
    triggerDownload(new Blob(['x']), 'a.bin');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake-url');
  });
});

describe('downloadBytes — partial-view handling', () => {
  it('passes a full-buffer typed array straight through (no copy)', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    downloadBytes('full.bin', bytes, 'application/octet-stream');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('application/octet-stream');
  });

  it('slices a subarray to its own bytes — not the whole backing buffer', async () => {
    // A 10-byte buffer viewed as bytes [3..6). `new Blob([subarray])` would
    // otherwise serialise all 10 bytes; downloadBytes must emit exactly 3.
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const view = backing.subarray(3, 6); // [3,4,5], offset 3, length 3
    downloadBytes('slice.bin', view, 'application/octet-stream');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.size).toBe(3);
    const out = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(out)).toEqual([3, 4, 5]);
  });
});

describe('downloadText', () => {
  it('defaults to text/plain and carries the text payload', async () => {
    downloadText('readme.txt', 'hello world');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello world');
  });

  it('honours an explicit MIME type', () => {
    downloadText('data.json', '{}', 'application/json');
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
  });
});
