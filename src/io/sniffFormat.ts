/**
 * Format detection for incoming scan files.
 *
 * Magic bytes are checked first (authoritative), file extension second.
 */

/** Every format the sniffer can report, including the catch-all `unknown`. */
export type DetectedFormat = 'ply' | 'las' | 'laz' | 'obj' | 'glb' | 'gltf' | 'unknown';

/** A concrete, loadable source format — `DetectedFormat` minus `unknown`. */
export type SourceFormat = Exclude<DetectedFormat, 'unknown'>;

/** Read the first `count` bytes of `buffer` as an ASCII string. */
function readAscii(buffer: ArrayBuffer, count: number): string {
  const view = new Uint8Array(buffer, 0, Math.min(count, buffer.byteLength));
  let out = '';
  for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
  return out;
}

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
 *  2. File extension — `.obj/.ply/.las/.laz/.glb/.gltf`.
 *  3. Otherwise `unknown`.
 */
export function sniffFormat(buffer: ArrayBuffer, filename: string): DetectedFormat {
  const magic = readAscii(buffer, 4);

  // 1. Magic bytes win over the extension.
  if (magic.startsWith('ply')) return 'ply';
  if (magic.startsWith('LASF')) {
    return extensionOf(filename) === 'laz' ? 'laz' : 'las';
  }
  // glTF binary: 0x67 0x6C 0x54 0x46 == 'glTF'.
  if (magic === 'glTF') return 'glb';

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
    default:
      return 'unknown';
  }
}
