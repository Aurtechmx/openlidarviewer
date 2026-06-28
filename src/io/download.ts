/**
 * download.ts — the single browser-download helper.
 *
 * Every export path funnels through here so the object-URL revoke is ALWAYS
 * deferred. Revoking immediately after `a.click()` is flaky on Safari / iOS and
 * for large blobs (PDF / DEM / PNG / batch ZIP / signed report), where the
 * download can be cancelled mid-flight because the URL is freed before the
 * transfer starts. A short deferred revoke lets the download begin first, then
 * releases the memory.
 */

/** Trigger a browser download of `blob` as `filename`, deferring the URL revoke. */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Appended + clicked + removed in one synchronous tick, so it never paints
  // (no display:none needed); the in-DOM anchor is what Firefox requires for a
  // programmatic click to fire.
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer past the click so large / Safari / iOS downloads complete.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download raw bytes with an explicit MIME type. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime: string): void {
  // Only copy when `bytes` is a partial view: `new Blob([typedArray])` serialises
  // the WHOLE backing ArrayBuffer, so a subarray (non-zero offset or shorter
  // length) must be sliced to its own bytes. A typed array that owns its whole
  // buffer passes straight through — no copy of a multi-MB export payload.
  const ab =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? (bytes.buffer as ArrayBuffer)
      : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  triggerDownload(new Blob([ab], { type: mime }), filename);
}

/** Download UTF-8 text (defaults to `text/plain`). */
export function downloadText(filename: string, text: string, mime = 'text/plain'): void {
  triggerDownload(new Blob([text], { type: mime }), filename);
}
