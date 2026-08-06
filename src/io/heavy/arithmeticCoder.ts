/**
 * arithmeticCoder.ts — the native arithmetic coder behind LAZ chunk tables.
 *
 * A plain LAZ file's chunk table — the index that turns a sequential stream
 * into independently decodable chunks — is itself arithmetic-coded with the
 * laszip scheme (an adaptive-model range coder derived from FastAC, plus an
 * integer corrector layered on top). Reading it without materialising the
 * whole file therefore needs this coder in TypeScript. The implementation
 * covers the full symmetric pair — decoder AND encoder — because the encoder
 * is what makes the decoder testable: every table the test suite decodes is
 * one this module encoded, and the round-trip must be exact to the byte.
 *
 * Bit-for-bit compatibility notes, all load-bearing:
 *   • All interval arithmetic is unsigned 32-bit. JS numbers are doubles, so
 *     every add/shift/multiply that can reach 2^31 is wrapped with `>>> 0`;
 *     products are exact because both factors stay under 2^17 × 2^15.
 *   • Adaptive models mutate on a fixed update cadence. Decoder and encoder
 *     must run models through IDENTICAL state sequences or the streams
 *     diverge; the model code is shared, not duplicated.
 *   • A decoder read past the end of the payload yields zero bytes. The final
 *     symbols of a stream are fully determined before those bytes are used,
 *     so zero-fill is the correct EOF behaviour for a bounded table slice.
 *
 * Scope: exactly what the chunk table needs (symbol models up to 256 symbols,
 * bit models, raw bits, and the 32-bit integer corrector with two contexts).
 * Point-record decompression stays in the laz-perf WASM — one chunk at a
 * time, the same per-chunk path the COPC reader uses.
 *
 * Pure, no DOM, no three.js — unit-tested in Node.
 */

// Interval bounds of the range coder.
const AC_MIN_LENGTH = 0x01000000;
const AC_MAX_LENGTH = 0xffffffff;

// Symbol-model scaling: distributions live in [0, 2^15).
const DM_LENGTH_SHIFT = 15;
const DM_MAX_COUNT = 1 << DM_LENGTH_SHIFT;

// Bit-model scaling: probabilities live in [0, 2^13).
const BM_LENGTH_SHIFT = 13;
const BM_MAX_COUNT = 1 << BM_LENGTH_SHIFT;

/** Adaptive binary model (probability of the 0 bit). */
export class ArithmeticBitModel {
  bit0Prob = 1 << (BM_LENGTH_SHIFT - 1);
  bit0Count = 1;
  bitCount = 2;
  updateCycle = 4;
  bitsUntilUpdate = 4;

  init(): void {
    this.bit0Count = 1;
    this.bitCount = 2;
    this.bit0Prob = 1 << (BM_LENGTH_SHIFT - 1);
    this.updateCycle = 4;
    this.bitsUntilUpdate = 4;
  }

  update(): void {
    this.bitCount += this.updateCycle;
    if (this.bitCount > BM_MAX_COUNT) {
      this.bitCount = (this.bitCount + 1) >> 1;
      this.bit0Count = (this.bit0Count + 1) >> 1;
      if (this.bit0Count === this.bitCount) ++this.bitCount;
    }
    const scale = Math.floor(0x80000000 / this.bitCount);
    this.bit0Prob = (this.bit0Count * scale) >>> (31 - BM_LENGTH_SHIFT);
    this.updateCycle = (5 * this.updateCycle) >> 2;
    if (this.updateCycle > 64) this.updateCycle = 64;
    this.bitsUntilUpdate = this.updateCycle;
  }
}

/**
 * Adaptive multi-symbol model. Models with more than 16 symbols carry a
 * decode acceleration table, exactly mirroring the reference layout so the
 * adaptation sequence — and therefore the bitstream — is identical.
 */
export class ArithmeticModel {
  readonly symbols: number;
  readonly lastSymbol: number;
  private readonly compress: boolean;
  distribution: Uint32Array;
  symbolCount: Uint32Array;
  decoderTable: Uint32Array | null;
  readonly tableSize: number;
  readonly tableShift: number;
  totalCount = 0;
  updateCycle = 0;
  symbolsUntilUpdate = 0;

  constructor(symbols: number, compress: boolean) {
    if (symbols < 2 || symbols > 1 << 11) {
      throw new Error(`ArithmeticModel: symbol count ${symbols} out of range`);
    }
    this.symbols = symbols;
    this.lastSymbol = symbols - 1;
    this.compress = compress;
    if (!compress && symbols > 16) {
      let tableBits = 3;
      while (symbols > 1 << (tableBits + 2)) ++tableBits;
      this.tableSize = 1 << tableBits;
      this.tableShift = DM_LENGTH_SHIFT - tableBits;
      this.decoderTable = new Uint32Array(this.tableSize + 2);
    } else {
      this.tableSize = 0;
      this.tableShift = 0;
      this.decoderTable = null;
    }
    this.distribution = new Uint32Array(symbols);
    this.symbolCount = new Uint32Array(symbols);
    this.init();
  }

  init(): void {
    this.totalCount = 0;
    this.updateCycle = this.symbols;
    this.symbolCount.fill(1);
    this.update();
    this.symbolsUntilUpdate = this.updateCycle = (this.symbols + 6) >> 1;
  }

  update(): void {
    this.totalCount += this.updateCycle;
    if (this.totalCount > DM_MAX_COUNT) {
      this.totalCount = 0;
      for (let n = 0; n < this.symbols; n++) {
        this.symbolCount[n] = (this.symbolCount[n] + 1) >> 1;
        this.totalCount += this.symbolCount[n];
      }
    }
    let sum = 0;
    const scale = Math.floor(0x80000000 / this.totalCount);
    if (this.compress || this.tableSize === 0) {
      for (let k = 0; k < this.symbols; k++) {
        this.distribution[k] = (scale * sum) >>> (31 - DM_LENGTH_SHIFT);
        sum += this.symbolCount[k];
      }
    } else {
      const table = this.decoderTable!;
      let s = 0;
      for (let k = 0; k < this.symbols; k++) {
        this.distribution[k] = (scale * sum) >>> (31 - DM_LENGTH_SHIFT);
        sum += this.symbolCount[k];
        const w = this.distribution[k] >>> this.tableShift;
        while (s < w) table[++s] = k - 1;
      }
      table[0] = 0;
      while (s <= this.tableSize) table[++s] = this.symbols - 1;
    }
    this.updateCycle = (5 * this.updateCycle) >> 2;
    const maxCycle = (this.symbols + 6) << 3;
    if (this.updateCycle > maxCycle) this.updateCycle = maxCycle;
    this.symbolsUntilUpdate = this.updateCycle;
  }
}

/** The range decoder over a bounded byte payload. */
export class ArithmeticDecoder {
  private readonly bytes: Uint8Array;
  private pos: number;
  private value = 0;
  private length = 0;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.pos = offset;
  }

  /** Bytes consumed so far (including the 4-byte priming read). */
  consumed(): number {
    return this.pos;
  }

  private getByte(): number {
    // Zero past the end: the trailing symbols of a stream never depend on
    // these bytes (see the file comment), and a bounded table slice must not
    // fault when the coder's lookahead crosses its edge.
    return this.pos < this.bytes.length ? this.bytes[this.pos++] : (this.pos++, 0);
  }

  init(): void {
    this.length = AC_MAX_LENGTH;
    this.value =
      ((this.getByte() << 24) | (this.getByte() << 16) | (this.getByte() << 8) | this.getByte()) >>>
      0;
  }

  private renorm(): void {
    do {
      this.value = ((this.value << 8) | this.getByte()) >>> 0;
      this.length = (this.length << 8) >>> 0;
    } while (this.length < AC_MIN_LENGTH);
  }

  decodeBit(m: ArithmeticBitModel): number {
    const x = (m.bit0Prob * (this.length >>> BM_LENGTH_SHIFT)) >>> 0;
    const sym = this.value >= x ? 1 : 0;
    if (sym === 0) {
      this.length = x;
      ++m.bit0Count;
    } else {
      this.value = (this.value - x) >>> 0;
      this.length = (this.length - x) >>> 0;
    }
    if (this.length < AC_MIN_LENGTH) this.renorm();
    if (--m.bitsUntilUpdate === 0) m.update();
    return sym;
  }

  decodeSymbol(m: ArithmeticModel): number {
    let sym: number;
    let x: number;
    let y = this.length;
    if (m.decoderTable) {
      this.length = this.length >>> DM_LENGTH_SHIFT;
      const dv = Math.floor(this.value / this.length);
      const t = dv >>> m.tableShift;
      sym = m.decoderTable[t];
      let n = m.decoderTable[t + 1] + 1;
      while (n > sym + 1) {
        const k = (sym + n) >>> 1;
        if (m.distribution[k] > dv) n = k;
        else sym = k;
      }
      x = (m.distribution[sym] * this.length) >>> 0;
      if (sym !== m.lastSymbol) y = (m.distribution[sym + 1] * this.length) >>> 0;
    } else {
      x = sym = 0;
      this.length = this.length >>> DM_LENGTH_SHIFT;
      let n = m.symbols;
      let k = n >>> 1;
      do {
        const z = (this.length * m.distribution[k]) >>> 0;
        if (z > this.value) {
          n = k;
          y = z;
        } else {
          sym = k;
          x = z;
        }
        k = (sym + n) >>> 1;
      } while (k !== sym);
    }
    this.value = (this.value - x) >>> 0;
    this.length = (y - x) >>> 0;
    if (this.length < AC_MIN_LENGTH) this.renorm();
    ++m.symbolCount[sym];
    if (--m.symbolsUntilUpdate === 0) m.update();
    return sym;
  }

  /** Raw (model-free) bits, 1–32. */
  readBits(bits: number): number {
    if (bits > 19) {
      const low = this.readShort();
      const high = this.readBits(bits - 16);
      return ((high << 16) | low) >>> 0;
    }
    this.length = this.length >>> bits;
    const sym = Math.floor(this.value / this.length);
    this.value = (this.value - sym * this.length) >>> 0;
    if (this.length < AC_MIN_LENGTH) this.renorm();
    if (sym >= 1 << bits) throw new Error('arithmetic decoder: raw-bits symbol out of range');
    return sym;
  }

  private readShort(): number {
    this.length = this.length >>> 16;
    const sym = Math.floor(this.value / this.length);
    this.value = (this.value - sym * this.length) >>> 0;
    if (this.length < AC_MIN_LENGTH) this.renorm();
    if (sym >= 1 << 16) throw new Error('arithmetic decoder: raw-short symbol out of range');
    return sym;
  }
}

/** The range encoder — the decoder's exact mirror, used by tests and writers. */
export class ArithmeticEncoder {
  private out: number[] = [];
  private base = 0;
  private length = AC_MAX_LENGTH;

  private propagateCarry(): void {
    let p = this.out.length - 1;
    while (p >= 0 && this.out[p] === 0xff) {
      this.out[p] = 0;
      p--;
    }
    if (p < 0) throw new Error('arithmetic encoder: carry past the start of the stream');
    this.out[p]++;
  }

  private renorm(): void {
    do {
      this.out.push((this.base >>> 24) & 0xff);
      this.base = (this.base << 8) >>> 0;
      this.length = (this.length << 8) >>> 0;
    } while (this.length < AC_MIN_LENGTH);
  }

  encodeBit(m: ArithmeticBitModel, sym: number): void {
    const x = (m.bit0Prob * (this.length >>> BM_LENGTH_SHIFT)) >>> 0;
    if (sym === 0) {
      this.length = x;
      ++m.bit0Count;
    } else {
      const initBase = this.base;
      this.base = (this.base + x) >>> 0;
      this.length = (this.length - x) >>> 0;
      if (initBase > this.base) this.propagateCarry();
    }
    if (this.length < AC_MIN_LENGTH) this.renorm();
    if (--m.bitsUntilUpdate === 0) m.update();
  }

  encodeSymbol(m: ArithmeticModel, sym: number): void {
    const initBase = this.base;
    let x: number;
    if (sym === m.lastSymbol) {
      x = (m.distribution[sym] * (this.length >>> DM_LENGTH_SHIFT)) >>> 0;
      this.base = (this.base + x) >>> 0;
      this.length = (this.length - x) >>> 0;
    } else {
      this.length = this.length >>> DM_LENGTH_SHIFT;
      x = (m.distribution[sym] * this.length) >>> 0;
      this.base = (this.base + x) >>> 0;
      this.length = ((m.distribution[sym + 1] * this.length) >>> 0) - x;
      this.length = this.length >>> 0;
    }
    if (initBase > this.base) this.propagateCarry();
    if (this.length < AC_MIN_LENGTH) this.renorm();
    ++m.symbolCount[sym];
    if (--m.symbolsUntilUpdate === 0) m.update();
  }

  writeBits(bits: number, sym: number): void {
    if (bits > 19) {
      this.writeShort(sym & 0xffff);
      sym = sym >>> 16;
      bits -= 16;
    }
    const initBase = this.base;
    this.length = this.length >>> bits;
    this.base = (this.base + sym * this.length) >>> 0;
    if (initBase > this.base) this.propagateCarry();
    if (this.length < AC_MIN_LENGTH) this.renorm();
  }

  private writeShort(sym: number): void {
    const initBase = this.base;
    this.length = this.length >>> 16;
    this.base = (this.base + sym * this.length) >>> 0;
    if (initBase > this.base) this.propagateCarry();
    if (this.length < AC_MIN_LENGTH) this.renorm();
  }

  /** Finish the stream and return its bytes. */
  done(): Uint8Array {
    const initBase = this.base;
    if (this.length > 2 * AC_MIN_LENGTH) {
      this.base = (this.base + AC_MIN_LENGTH) >>> 0;
      this.length = AC_MIN_LENGTH >>> 1;
    } else {
      this.base = (this.base + (AC_MIN_LENGTH >>> 1)) >>> 0;
      this.length = AC_MIN_LENGTH >>> 9;
    }
    if (initBase > this.base) this.propagateCarry();
    this.renorm();
    return new Uint8Array(this.out);
  }
}

// ── The laszip integer corrector ────────────────────────────────────────────
//
// Values are coded as correctors against a caller-supplied prediction: a
// symbol k names the interval the corrector falls into, then k bits locate it
// (arithmetic-modelled up to 8 bits, raw above). The chunk table uses the
// 32-bit / two-context configuration: context 0 for point-count deltas,
// context 1 for byte-offset deltas.

const CORR_BITS = 32;
const BITS_HIGH = 8;
const I32_MIN = -2147483648;

/** Decoder side of the 32-bit integer corrector. */
export class IntegerDecompressor {
  private readonly dec: ArithmeticDecoder;
  private readonly mBits: ArithmeticModel[];
  private readonly mCorrector0: ArithmeticBitModel;
  private readonly mCorrector: (ArithmeticModel | null)[];

  constructor(dec: ArithmeticDecoder, contexts: number) {
    this.dec = dec;
    this.mBits = [];
    for (let i = 0; i < contexts; i++) this.mBits.push(new ArithmeticModel(CORR_BITS + 1, false));
    this.mCorrector0 = new ArithmeticBitModel();
    this.mCorrector = [null];
    for (let k = 1; k <= CORR_BITS; k++) {
      this.mCorrector.push(
        new ArithmeticModel(k <= BITS_HIGH ? 1 << k : 1 << BITS_HIGH, false),
      );
    }
  }

  /** Decode the next value against `pred` in the given context. Signed 32-bit. */
  decompress(pred: number, context: number): number {
    const real = (pred + this.readCorrector(this.mBits[context])) | 0;
    // corr_range is 2^32 here, so the |0 wrap IS the interval fold.
    return real;
  }

  private readCorrector(mBits: ArithmeticModel): number {
    const k = this.dec.decodeSymbol(mBits);
    let c: number;
    if (k !== 0) {
      if (k < 32) {
        if (k <= BITS_HIGH) {
          c = this.dec.decodeSymbol(this.mCorrector[k]!);
        } else {
          const k1 = k - BITS_HIGH;
          const high = this.dec.decodeSymbol(this.mCorrector[k]!);
          const low = this.dec.readBits(k1);
          c = ((high << k1) | low) >>> 0;
        }
        // Fold c back into its signed interval.
        if (c >= ((1 << (k - 1)) >>> 0)) c += 1;
        else c -= ((1 << k) >>> 0) - 1;
      } else {
        c = I32_MIN;
      }
    } else {
      c = this.dec.decodeBit(this.mCorrector0);
    }
    return c;
  }
}

/** Encoder side — the exact mirror, for tests and the future tile writer. */
export class IntegerCompressorEnc {
  private readonly enc: ArithmeticEncoder;
  private readonly mBits: ArithmeticModel[];
  private readonly mCorrector0: ArithmeticBitModel;
  private readonly mCorrector: (ArithmeticModel | null)[];

  constructor(enc: ArithmeticEncoder, contexts: number) {
    this.enc = enc;
    this.mBits = [];
    for (let i = 0; i < contexts; i++) this.mBits.push(new ArithmeticModel(CORR_BITS + 1, true));
    this.mCorrector0 = new ArithmeticBitModel();
    this.mCorrector = [null];
    for (let k = 1; k <= CORR_BITS; k++) {
      this.mCorrector.push(
        new ArithmeticModel(k <= BITS_HIGH ? 1 << k : 1 << BITS_HIGH, true),
      );
    }
  }

  compress(pred: number, real: number, context: number): void {
    const corr = (real - pred) | 0;
    this.writeCorrector(corr, this.mBits[context]);
  }

  private writeCorrector(c: number, mBits: ArithmeticModel): void {
    // The tightest interval [-(2^k - 1), 2^k] containing c.
    let k = 0;
    let c1 = c <= 0 ? -c : c - 1;
    while (c1) {
      c1 = Math.floor(c1 / 2);
      k++;
    }
    this.enc.encodeSymbol(mBits, k);
    if (k !== 0) {
      if (k < 32) {
        // Translate into [0, 2^k).
        if (c >= 0) c -= 1;
        else c += ((1 << k) >>> 0) - 1;
        if (k <= BITS_HIGH) {
          this.enc.encodeSymbol(this.mCorrector[k]!, c);
        } else {
          const k1 = k - BITS_HIGH;
          const low = c & ((1 << k1) - 1);
          const high = c >>> k1;
          this.enc.encodeSymbol(this.mCorrector[k]!, high);
          this.enc.writeBits(k1, low);
        }
      }
      // k === 32 carries no payload: the corrector IS the interval floor.
    } else {
      this.enc.encodeBit(this.mCorrector0, c);
    }
  }
}
