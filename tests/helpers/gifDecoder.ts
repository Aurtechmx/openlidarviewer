/**
 * gifDecoder.ts — a small, independent GIF89a reader for the encoder tests.
 *
 * Written from the format description, not from the encoder: it reads the
 * header, the global colour table, the extensions (looping, comments, frame
 * delays) and every image's LZW stream with the decoder's own code-size rule
 * (grow once the next free code reaches 2^size, stop at 12 bits), and returns
 * each frame's rectangle and indices. It also composites the frames, under
 * disposal "do not dispose", into full screens.
 */

export interface DecodedFrame {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly delayCs: number;
  readonly disposal: number;
  readonly indices: Uint8Array;
}

export interface DecodedGif {
  readonly version: string;
  readonly width: number;
  readonly height: number;
  /** RGB triplets of the global colour table, as stored (padded to a power of two). */
  readonly palette: Uint8Array;
  readonly loop: number | null;
  readonly comments: string[];
  readonly frames: DecodedFrame[];
  /** Every frame composited onto the screen (indices into the palette). */
  readonly screens: Uint8Array[];
}

function readSubBlocks(b: Uint8Array, p: number): { data: Uint8Array; next: number } {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const n = b[p++]!;
    if (n === 0) break;
    parts.push(b.subarray(p, p + n));
    total += n;
    p += n;
  }
  const data = new Uint8Array(total);
  let o = 0;
  for (const part of parts) { data.set(part, o); o += part.length; }
  return { data, next: p };
}

export function lzwDecode(data: Uint8Array, minCodeSize: number, pixels: number): Uint8Array {
  const clear = 1 << minCodeSize, eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let dict: number[][] = [];
  const resetDict = (): void => {
    dict = [];
    for (let i = 0; i < clear; i++) dict.push([i]);
    dict.push([], []);
  };
  resetDict();
  const out: number[] = [];
  let prev: number[] | null = null;
  let bit = 0;
  const totalBits = data.length * 8;
  while (bit + codeSize <= totalBits) {
    let code = 0;
    for (let k = 0; k < codeSize; k++, bit++) code |= ((data[bit >> 3]! >> (bit & 7)) & 1) << k;
    if (code === clear) { codeSize = minCodeSize + 1; resetDict(); prev = null; continue; }
    if (code === eoi) break;
    let entry: number[];
    if (prev === null) {
      entry = dict[code]!;
      if (!entry) throw new Error(`first code ${code} after a clear is not a root`);
    } else if (code < dict.length) {
      entry = dict[code]!;
      if (dict.length < 4096) dict.push([...prev, entry[0]!]);
    } else if (code === dict.length) {
      entry = [...prev, prev[0]!];
      dict.push(entry);
    } else {
      throw new Error(`code ${code} beyond the dictionary (${dict.length})`);
    }
    out.push(...entry);
    if (dict.length >= (1 << codeSize) && codeSize < 12) codeSize++;
    prev = entry;
  }
  if (out.length !== pixels) throw new Error(`decoded ${out.length} pixels, expected ${pixels}`);
  return Uint8Array.from(out);
}

export function decodeGif(b: Uint8Array): DecodedGif {
  const ascii = (p: number, n: number) => String.fromCharCode(...b.subarray(p, p + n));
  const u16 = (p: number) => b[p]! | (b[p + 1]! << 8);
  const version = ascii(0, 6);
  if (version !== 'GIF89a' && version !== 'GIF87a') throw new Error(`not a GIF: ${version}`);
  const width = u16(6), height = u16(8);
  const packed = b[10]!;
  let p = 13;
  let palette = new Uint8Array(0);
  if (packed & 0x80) {
    const size = 1 << ((packed & 7) + 1);
    palette = b.slice(p, p + size * 3);
    p += size * 3;
  }
  let loop: number | null = null;
  const comments: string[] = [];
  const frames: DecodedFrame[] = [];
  let delayCs = 0, disposal = 0;
  for (;;) {
    const kind = b[p++];
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = b[p++]!;
      if (label === 0xf9) {
        const blk = readSubBlocks(b, p);
        disposal = (blk.data[0]! >> 2) & 7;
        delayCs = blk.data[1]! | (blk.data[2]! << 8);
        p = blk.next;
      } else if (label === 0xff) {
        const n = b[p]!;
        const id = ascii(p + 1, n);
        const blk = readSubBlocks(b, p + 1 + n);
        if (id === 'NETSCAPE2.0' && blk.data[0] === 1) loop = blk.data[1]! | (blk.data[2]! << 8);
        p = blk.next;
      } else {
        const blk = readSubBlocks(b, p);
        if (label === 0xfe) comments.push(new TextDecoder().decode(blk.data));
        p = blk.next;
      }
      continue;
    }
    if (kind === 0x2c) {
      const left = u16(p), top = u16(p + 2), w = u16(p + 4), h = u16(p + 6);
      const ipacked = b[p + 8]!;
      p += 9;
      if (ipacked & 0x80) p += (1 << ((ipacked & 7) + 1)) * 3;
      const minCodeSize = b[p++]!;
      const blk = readSubBlocks(b, p);
      p = blk.next;
      frames.push({ left, top, width: w, height: h, delayCs, disposal, indices: lzwDecode(blk.data, minCodeSize, w * h) });
      delayCs = 0; disposal = 0;
      continue;
    }
    throw new Error(`unexpected block 0x${(kind ?? 0).toString(16)} at ${p - 1}`);
  }
  const screens: Uint8Array[] = [];
  let screen = new Uint8Array(width * height);
  for (const f of frames) {
    screen = screen.slice();
    for (let y = 0; y < f.height; y++) {
      screen.set(f.indices.subarray(y * f.width, (y + 1) * f.width), (f.top + y) * width + f.left);
    }
    screens.push(screen);
  }
  return { version, width, height, palette, loop, comments, frames, screens };
}
