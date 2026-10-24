/**
 * gifEncoder.ts — a small GIF89a writer for indexed-colour animations.
 *
 * What it writes, in order: the header and logical screen descriptor with one
 * global colour table (padded to a power of two, at most 256 entries); the
 * NETSCAPE2.0 application extension for looping; an optional comment
 * extension (7-bit ASCII, as the format requires); then per frame a graphic
 * control extension (delay in hundredths of a second, disposal "do not
 * dispose", no transparency) and an image descriptor whose rectangle may be a
 * sub-rectangle of the screen, so a frame can carry only what changed; then
 * the trailer.
 *
 * Image data is LZW-compressed as the GIF89a specification describes: codes
 * start one bit wider than the minimum code size, grow by one bit each time
 * the next dictionary code would not fit, stop growing at 12 bits, and a clear
 * code resets the dictionary when all 4096 codes are used. Codes are packed
 * least-significant bit first into data sub-blocks of at most 255 bytes.
 *
 * Pure: bytes in, bytes out. No DOM, no canvas.
 */

import { asciiFold } from './safeText';

/** One frame: palette indices for a rectangle of the logical screen. */
export interface GifFrame {
  readonly indices: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Offset of the rectangle on the screen; default 0. */
  readonly left?: number;
  readonly top?: number;
  /** Display time in hundredths of a second. */
  readonly delayCs: number;
}

export interface GifWriterOptions {
  /** Times to repeat after the first play; 0 loops forever (the default). */
  readonly loop?: number;
  /** Plain text stored in a comment extension. */
  readonly comment?: string | null;
}

const MAX_CODES = 4096;

/** A growable byte buffer. */
class ByteSink {
  private _buf = new Uint8Array(1 << 16);
  private _len = 0;

  get length(): number { return this._len; }

  private _ensure(extra: number): void {
    if (this._len + extra <= this._buf.length) return;
    let cap = this._buf.length * 2;
    while (cap < this._len + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this._buf.subarray(0, this._len));
    this._buf = next;
  }

  byte(b: number): void { this._ensure(1); this._buf[this._len++] = b & 0xff; }

  u16(v: number): void { this.byte(v & 0xff); this.byte((v >>> 8) & 0xff); }

  bytes(b: ArrayLike<number>): void {
    this._ensure(b.length);
    for (let i = 0; i < b.length; i++) this._buf[this._len++] = b[i]! & 0xff;
  }

  ascii(s: string): void { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }

  /** Write `data` as data sub-blocks of at most 255 bytes, then the block terminator. */
  subBlocks(data: Uint8Array): void {
    for (let p = 0; p < data.length; p += 255) {
      const n = Math.min(255, data.length - p);
      this.byte(n);
      this._ensure(n);
      this._buf.set(data.subarray(p, p + n), this._len);
      this._len += n;
    }
    this.byte(0);
  }

  result(): Uint8Array { return this._buf.slice(0, this._len); }
}

/** Smallest power of two, at least 2, holding `n` colours, as its exponent. */
function tableBits(n: number): number {
  let bits = 1;
  while ((1 << bits) < n) bits++;
  return bits;
}

/**
 * The GIF minimum LZW code size for a colour table of `2^bits` entries: the
 * bit count, but never below 2 (the format's floor).
 */
export function minCodeSizeFor(paletteSize: number): number {
  return Math.max(2, tableBits(paletteSize));
}

/**
 * LZW-encode `indices` with the given minimum code size into a packed code
 * stream (not yet split into sub-blocks). `table`/`stamp` are scratch the
 * caller may reuse between calls.
 */
export function lzwEncode(
  indices: Uint8Array,
  minCodeSize: number,
  scratch: { table: Int32Array; stamp: Uint32Array; generation: number } = newLzwScratch(),
): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const out = new ByteSink();
  let bitBuf = 0, bitCount = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  const emit = (code: number): void => {
    bitBuf |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.byte(bitBuf & 0xff);
      bitBuf >>>= 8;
      bitCount -= 8;
    }
  };
  const reset = (): void => {
    scratch.generation++;
    if (scratch.generation > 0xfffffff0) { scratch.stamp.fill(0); scratch.generation = 1; }
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };
  reset();
  emit(clearCode);
  if (indices.length === 0) {
    emit(eoiCode);
    if (bitCount > 0) out.byte(bitBuf & 0xff);
    return out.result();
  }
  const mask = clearCode - 1;
  let prefix = indices[0]! & mask;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]! & mask;
    const key = (prefix << 8) | k;
    if (scratch.stamp[key] === scratch.generation) {
      prefix = scratch.table[key]!;
      continue;
    }
    emit(prefix);
    if (nextCode === MAX_CODES) {
      emit(clearCode);
      reset();
    } else {
      if (nextCode >= (1 << codeSize)) codeSize++;
      scratch.table[key] = nextCode++;
      scratch.stamp[key] = scratch.generation;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoiCode);
  if (bitCount > 0) out.byte(bitBuf & 0xff);
  return out.result();
}

/** Scratch tables for {@link lzwEncode}: one slot per (prefix code, byte) pair. */
export function newLzwScratch(): { table: Int32Array; stamp: Uint32Array; generation: number } {
  return { table: new Int32Array(MAX_CODES << 8), stamp: new Uint32Array(MAX_CODES << 8), generation: 0 };
}

/**
 * Writes one GIF89a file frame by frame, so a caller can yield between frames.
 * `palette` is RGB triplets, at most 256 colours.
 */
export class GifWriter {
  private readonly _sink = new ByteSink();
  private readonly _minCodeSize: number;
  private readonly _paletteSize: number;
  private readonly _scratch = newLzwScratch();
  private _frames = 0;
  private _done = false;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number, palette: Uint8Array, opts: GifWriterOptions = {}) {
    this.width = width;
    this.height = height;
    if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width < 65536 && height < 65536)) {
      throw new RangeError(`GIF size must be 1 to 65535 pixels a side; got ${width} x ${height}`);
    }
    const colours = Math.floor(palette.length / 3);
    if (colours < 1 || colours > 256 || palette.length % 3 !== 0) {
      throw new RangeError(`GIF palette must hold 1 to 256 RGB colours; got ${palette.length} bytes`);
    }
    const bits = tableBits(colours);
    this._paletteSize = 1 << bits;
    this._minCodeSize = minCodeSizeFor(this._paletteSize);
    const s = this._sink;
    s.ascii('GIF89a');
    s.u16(width);
    s.u16(height);
    // Global colour table present, 8-bit colour resolution, unsorted, table size 2^bits.
    s.byte(0x80 | (7 << 4) | (bits - 1));
    s.byte(0); // background colour index
    s.byte(0); // pixel aspect ratio: not given
    const table = new Uint8Array(this._paletteSize * 3);
    table.set(palette);
    s.bytes(table);
    // NETSCAPE2.0 looping extension.
    s.bytes([0x21, 0xff, 0x0b]);
    s.ascii('NETSCAPE2.0');
    s.bytes([0x03, 0x01]);
    s.u16(Math.max(0, Math.min(65535, opts.loop ?? 0)));
    s.byte(0);
    if (opts.comment) {
      s.bytes([0x21, 0xfe]);
      s.subBlocks(new TextEncoder().encode(asciiFold(opts.comment)));
    }
  }

  get frameCount(): number { return this._frames; }

  /** Append one frame. Indices must be below the palette size. */
  addFrame(frame: GifFrame): void {
    if (this._done) throw new Error('GIF already finished');
    const left = frame.left ?? 0, top = frame.top ?? 0;
    const { width, height } = frame;
    if (width < 1 || height < 1 || left < 0 || top < 0 || left + width > this.width || top + height > this.height) {
      throw new RangeError(`GIF frame ${width} x ${height} at (${left}, ${top}) does not fit the ${this.width} x ${this.height} screen`);
    }
    if (frame.indices.length !== width * height) {
      throw new RangeError(`GIF frame holds ${frame.indices.length} indices for ${width} x ${height} pixels`);
    }
    const s = this._sink;
    // Graphic control extension: disposal 1 (leave in place), no user input, no transparency.
    s.bytes([0x21, 0xf9, 0x04, 1 << 2]);
    s.u16(Math.max(0, Math.min(65535, Math.round(frame.delayCs))));
    s.byte(0);
    s.byte(0);
    // Image descriptor: no local table, not interlaced.
    s.byte(0x2c);
    s.u16(left);
    s.u16(top);
    s.u16(width);
    s.u16(height);
    s.byte(0);
    s.byte(this._minCodeSize);
    s.subBlocks(lzwEncode(frame.indices, this._minCodeSize, this._scratch));
    this._frames++;
  }

  /** Write the trailer and return the file. */
  finish(): Uint8Array {
    if (!this._done) { this._sink.byte(0x3b); this._done = true; }
    return this._sink.result();
  }
}
