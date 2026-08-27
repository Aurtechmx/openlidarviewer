/**
 * subtree3d.ts — synthetic `.subtree` bodies, built rather than shipped.
 *
 * The same principle as `tileset3d.ts` beside it: a subtree is a 24-byte header,
 * a small JSON chunk and at most a few bytes of bitstream, so every case a
 * reader has to survive can be constructed in a line or two. The header
 * overrides exist so the malformed cases are built deliberately (a wrong magic,
 * an unknown version, a length that overruns the body) instead of being
 * approximated by slicing a valid file and hoping the damage lands somewhere
 * interesting.
 *
 * Pure: no fetch, no DOM.
 */

/** Availability meaning "every tile in this subtree exists". */
export const ALL_AVAILABLE = { constant: 1 } as const;
/** Availability meaning "none of them do". */
export const NONE_AVAILABLE = { constant: 0 } as const;

/** Header fields a caller may state instead of having them derived. */
export interface SubtreeHeaderOverrides {
  /** The binary chunk. Defaults to empty. */
  readonly binary?: Uint8Array;
  /** Four bytes to write instead of `subt`. */
  readonly magic?: string;
  /** A version other than 1. */
  readonly version?: number;
  /** A JSON chunk length other than the real one. */
  readonly jsonByteLength?: number;
  /** A binary chunk length other than the real one. */
  readonly binaryByteLength?: number;
  /** Cut the finished body to this many bytes. */
  readonly truncateTo?: number;
}

/**
 * One availability bitstream, LSB-first within each byte, sized to `bits`.
 *
 * `values[i]` is the bit for element `i`, so index 8 is bit 0 of byte 1. Any
 * value past `bits` is ignored; any bit past the end of `values` is 0.
 */
export function bitstream(values: readonly boolean[], bits = values.length): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits / 8));
  for (let i = 0; i < bits; i++) {
    if (values[i]) out[i >> 3] = (out[i >> 3] as number) | (1 << (i & 7));
  }
  return out;
}

/** A `.subtree` body: the header, the JSON chunk padded to 8 bytes, the binary. */
export function makeSubtree(json: object, overrides: SubtreeHeaderOverrides = {}): ArrayBuffer {
  let text = JSON.stringify(json);
  // The spec pads the JSON chunk with trailing spaces to an 8-byte boundary so
  // the binary chunk that follows stays aligned.
  while (text.length % 8 !== 0) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const binary = overrides.binary ?? new Uint8Array(0);
  const total = 24 + jsonBytes.length + binary.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const magic = overrides.magic ?? 'subt';
  for (let i = 0; i < 4; i++) out[i] = magic.charCodeAt(i) & 0xff;
  view.setUint32(4, overrides.version ?? 1, true);
  view.setBigUint64(8, BigInt(overrides.jsonByteLength ?? jsonBytes.length), true);
  view.setBigUint64(16, BigInt(overrides.binaryByteLength ?? binary.length), true);
  out.set(jsonBytes, 24);
  out.set(binary, 24 + jsonBytes.length);
  const body = overrides.truncateTo === undefined ? out : out.subarray(0, overrides.truncateTo);
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}
