/**
 * textChunks.ts — line sinks for the ASCII writers.
 *
 * The writers used to build one string per point, join them into a single
 * string and encode that. A single JS string tops out near 5.4e8 characters, so
 * a full-resolution export past roughly 13-17M points threw "Invalid string
 * length", and the join, the encode and the output were all alive at once.
 *
 * A writer now emits each line to a {@link LineSink}. {@link Utf8ChunkSink}
 * encodes the text in bounded pieces as it goes, so no string outgrows one
 * chunk; {@link StringLineSink} keeps the string form for callers that want
 * text (small exports, tests). Both terminate every line with `\n`, which is
 * the same text `lines.join('\n') + '\n'` produced.
 *
 * Chunks are cut only after a `\n`, never inside a line, so a surrogate pair
 * can never be split across two encodes and the concatenated bytes equal the
 * bytes of the whole string encoded at once.
 */

/** Where a writer sends its lines. Each line is terminated with `\n`. */
export interface LineSink {
  line(text: string): void;
}

/** Characters gathered before a chunk is encoded (4 Mi chars, about 4 MiB of ASCII). */
export const DEFAULT_CHUNK_CHARS = 4 * 1024 * 1024;

/** Encodes lines into `Uint8Array` chunks of about `chunkChars` characters. */
export class Utf8ChunkSink implements LineSink {
  private readonly encoder = new TextEncoder();
  private readonly out: Uint8Array[] = [];
  private pending = '';

  private readonly chunkChars: number;

  constructor(chunkChars: number = DEFAULT_CHUNK_CHARS) {
    this.chunkChars = chunkChars;
  }

  line(text: string): void {
    this.pending += text;
    this.pending += '\n';
    if (this.pending.length >= this.chunkChars) this.flush();
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    this.out.push(this.encoder.encode(this.pending));
    this.pending = '';
  }

  /** The encoded chunks, in order. */
  chunks(): Uint8Array[] {
    this.flush();
    return this.out;
  }

  /** The whole output as one array, assembled once. */
  bytes(): Uint8Array {
    return joinChunks(this.chunks());
  }
}

/** Collects lines as text. For small outputs; a very large one overflows the string limit. */
export class StringLineSink implements LineSink {
  private readonly parts: string[] = [];

  line(text: string): void {
    this.parts.push(text);
  }

  text(): string {
    return this.parts.length > 0 ? this.parts.join('\n') + '\n' : '';
  }
}

/** Concatenate chunks into one array, allocating the result once. */
export function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
