/**
 * Format detection for incoming scan files.
 *
 * Magic bytes are checked first (authoritative), file extension second.
 */

/** Every format the sniffer can report, including the catch-all `unknown`. */
export type DetectedFormat =
  | 'ply'
  | 'las'
  | 'laz'
  | 'obj'
  | 'glb'
  | 'gltf'
  | 'xyz'
  | 'e57'
  | 'unknown';

/** A concrete, loadable source format — `DetectedFormat` minus `unknown`. */
export type SourceFormat = Exclude<DetectedFormat, 'unknown'>;

/**
 * Whether a format's native coordinate frame is Z-up. Survey and scanner
 * formats — LAS, LAZ, XYZ, and E57 — are Z-up; phone-scan mesh formats
 * (PLY, OBJ, GLB/GLTF) are Y-up. Shared by the renderer and the session
 * exporter so the two can never disagree on a format's up axis.
 */
export function isZUpFormat(format: SourceFormat): boolean {
  return (
    format === 'las' || format === 'laz' || format === 'xyz' || format === 'e57'
  );
}

/** Read the first `count` bytes of `buffer` as an ASCII string. */
function readAscii(buffer: ArrayBuffer, count: number): string {
  const view = new Uint8Array(buffer, 0, Math.min(count, buffer.byteLength));
  let out = '';
  for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
  return out;
}

/**
 * Byte offset of the point-data-record-format field in the LAS public header.
 * Its high bit (0x80) is set by LAZ to flag that the records are compressed.
 */
const LAS_POINT_FORMAT_OFFSET = 104;

/** Extract the lowercased file extension (without the dot), or '' if none. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Detect the format of a scan file from its bytes and filename.
 *
 * Detection order:
 *  1. Magic bytes — `ply`, `LASF`, `glTF` — are authoritative.
 *  2. File extension — `.obj/.ply/.las/.laz/.glb/.gltf/.xyz/.csv`.
 *  3. Otherwise `unknown`.
 *
 * For a `LASF` file, LAS vs LAZ is decided by the compression bit in the
 * point-format byte (offset 104) — the authoritative signal — when the buffer
 * is long enough to reach it; a short buffer falls back to the extension.
 *
 * `.xyz` and `.csv` are plain text with no magic bytes, so they are detected
 * by extension only.
 */
export function sniffFormat(buffer: ArrayBuffer, filename: string): DetectedFormat {
  const magic = readAscii(buffer, 8);

  // 1. Magic bytes win over the extension.
  if (magic.startsWith('ASTM-E57')) return 'e57';
  if (magic.startsWith('ply')) return 'ply';
  if (magic.startsWith('LASF')) {
    // LAZ is LAS with the records compressed; the high bit of the point-format
    // byte is authoritative. The v0.2.7 head slice always reaches it; a short
    // buffer (older callers, tests) falls back to the file extension.
    if (buffer.byteLength > LAS_POINT_FORMAT_OFFSET) {
      const compressed = (new Uint8Array(buffer)[LAS_POINT_FORMAT_OFFSET] & 0x80) !== 0;
      return compressed ? 'laz' : 'las';
    }
    return extensionOf(filename) === 'laz' ? 'laz' : 'las';
  }
  // glTF binary: 0x67 0x6C 0x54 0x46 == 'glTF'.
  if (magic.startsWith('glTF')) return 'glb';

  // 2. Fall back to the file extension.
  switch (extensionOf(filename)) {
    case 'obj':
      return 'obj';
    case 'ply':
      return 'ply';
    case 'las':
      return 'las';
    case 'laz':
      return 'laz';
    case 'glb':
      return 'glb';
    case 'gltf':
      return 'gltf';
    case 'xyz':
    case 'csv':
      return 'xyz';
    case 'e57':
      return 'e57';
    default:
      return 'unknown';
  }
}
