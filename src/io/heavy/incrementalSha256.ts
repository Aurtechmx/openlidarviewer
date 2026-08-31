/**
 * incrementalSha256.ts — a streaming, bounded-memory SHA-256 (FIPS 180-4).
 *
 * The OOC cache needs the digest of an ENTIRE multi-gigabyte source to decide
 * whether a persisted index still matches the file. Concatenating the file into
 * one buffer to hash it would defeat the bounded-memory promise the out-of-core
 * path exists for, and the synchronous one-shot `sha256Bytes` in
 * `terrain/export/sha256.ts` (built for KB–MB deliverable files) allocates a
 * padded copy of its whole input. This is the same FIPS 180-4 compression, run
 * incrementally: feed it the file a bounded window at a time with `update`, then
 * `digestHex()`.
 *
 * Buffers only a partial 64-byte block between updates, so working memory is a
 * constant regardless of the number of bytes hashed. Deterministic, no DOM, no
 * three.js, and matches Web Crypto / Node `crypto` for the same input (pinned by
 * the tests against the published FIPS vectors and against `crypto.subtle`).
 */

// Round constants: first 32 bits of the fractional parts of the cube roots of
// the first 64 primes (FIPS 180-4 §4.2.2).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** A streaming SHA-256 hasher. Feed bytes with {@link update}, finish with
 *  {@link digestBytes} / {@link digestHex}. One-shot after finishing. */
export class IncrementalSha256 {
  // Working hash state: fractional parts of the square roots of the first 8 primes.
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  /** Partial block carried between updates (0..63 bytes). */
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  /** Total bytes fed so far, for the length suffix. */
  private totalBytes = 0;
  private finished = false;
  /** Reused 64-word message schedule, so update() allocates nothing per block. */
  private readonly w = new Uint32Array(64);

  /** Compress one full 64-byte block starting at `off` in `data`. */
  private compress(data: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this.h0, b = this.h1, c = this.h2, d = this.h3;
    let e = this.h4, f = this.h5, g = this.h6, h = this.h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }

  /** Fold `bytes` into the running digest. Cheap and bounded: at most one 64-byte
   *  block is buffered between calls. */
  update(bytes: Uint8Array): this {
    if (this.finished) throw new Error('IncrementalSha256: update after digest');
    this.totalBytes += bytes.length;
    let i = 0;
    // Top up a partial block first.
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, bytes.length);
      this.block.set(bytes.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    // Compress full blocks straight out of the input.
    for (; i + 64 <= bytes.length; i += 64) this.compress(bytes, i);
    // Carry the remainder.
    if (i < bytes.length) {
      const rem = bytes.length - i;
      this.block.set(bytes.subarray(i), 0);
      this.blockLen = rem;
    }
    return this;
  }

  /** Finish and return the raw 32-byte digest. Idempotent-unsafe: call once. */
  digestBytes(): Uint8Array {
    if (this.finished) throw new Error('IncrementalSha256: digest called twice');
    this.finished = true;
    const bitLen = this.totalBytes * 8;
    // Pad: 0x80, then zeros, then the 64-bit big-endian bit length.
    const padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;
    // 64-bit length. JS bit ops are 32-bit, so split into high/low words; the
    // high word carries lengths beyond 2^32 bits (512 MiB) using float math.
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    tail[padLen] = (hi >>> 24) & 0xff;
    tail[padLen + 1] = (hi >>> 16) & 0xff;
    tail[padLen + 2] = (hi >>> 8) & 0xff;
    tail[padLen + 3] = hi & 0xff;
    tail[padLen + 4] = (lo >>> 24) & 0xff;
    tail[padLen + 5] = (lo >>> 16) & 0xff;
    tail[padLen + 6] = (lo >>> 8) & 0xff;
    tail[padLen + 7] = lo & 0xff;
    this.update = () => {
      throw new Error('IncrementalSha256: update after digest');
    };
    // Feed the tail through the same block machinery via a temporary path that
    // does not touch `finished`/`totalBytes`.
    this.absorbTail(tail);
    const out = new Uint8Array(32);
    const hs = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (hs[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (hs[i] >>> 8) & 0xff;
      out[i * 4 + 3] = hs[i] & 0xff;
    }
    return out;
  }

  /** Absorb the final padding tail (a multiple of 64 bytes once combined with
   *  the carried partial block). */
  private absorbTail(tail: Uint8Array): void {
    // Complete the carried block, then compress any remaining full blocks.
    let i = 0;
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      this.block.set(tail.subarray(0, need), this.blockLen);
      this.compress(this.block, 0);
      this.blockLen = 0;
      i = need;
    }
    for (; i + 64 <= tail.length; i += 64) this.compress(tail, i);
  }

  /** Finish and return the digest as lowercase hex. */
  digestHex(): string {
    const bytes = this.digestBytes();
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  }
}

/** Convenience: the lowercase-hex SHA-256 of a single buffer, via the streaming
 *  core. For whole-file hashing prefer feeding {@link IncrementalSha256.update}
 *  bounded windows so nothing large is materialised at once. */
export function incrementalSha256Hex(bytes: Uint8Array): string {
  return new IncrementalSha256().update(bytes).digestHex();
}
