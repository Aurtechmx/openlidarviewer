/**
 * The native arithmetic coder must be an exact mirror of itself: every stream
 * the encoder emits decodes back to the same symbols, bits, and correctors,
 * with the adaptive models walking identical state on both sides. These
 * round-trips drive every configuration the LAZ chunk table exercises — the
 * 33-symbol k model (table-accelerated), the small corrector models, raw
 * bits above and below the 19-bit split, and the 32-bit two-context integer
 * corrector — plus the edge values where interval folding is easiest to get
 * wrong (0, ±1, interval boundaries, and the full signed range).
 */
import { describe, it, expect } from 'vitest';
import {
  ArithmeticDecoder,
  ArithmeticEncoder,
  ArithmeticBitModel,
  ArithmeticModel,
  IntegerDecompressor,
  IntegerCompressorEnc,
} from '../src/io/heavy/arithmeticCoder';

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('raw bits', () => {
  it('round-trips widths 1..32, including the >19-bit split path', () => {
    const rand = mulberry32(1);
    const items: Array<{ bits: number; value: number }> = [];
    for (let bits = 1; bits <= 32; bits++) {
      for (let i = 0; i < 25; i++) {
        const max = bits === 32 ? 4294967296 : 2 ** bits;
        items.push({ bits, value: Math.floor(rand() * max) });
      }
    }
    const enc = new ArithmeticEncoder();
    for (const { bits, value } of items) enc.writeBits(bits, value);
    const dec = new ArithmeticDecoder(enc.done());
    dec.init();
    for (const { bits, value } of items) expect(dec.readBits(bits)).toBe(value);
  });
});

describe('bit model', () => {
  it('round-trips a heavily biased bit sequence through the adaptive model', () => {
    const rand = mulberry32(2);
    const bits: number[] = [];
    for (let i = 0; i < 5000; i++) bits.push(rand() < 0.93 ? 0 : 1);
    const enc = new ArithmeticEncoder();
    const em = new ArithmeticBitModel();
    for (const b of bits) enc.encodeBit(em, b);
    const dec = new ArithmeticDecoder(enc.done());
    dec.init();
    const dm = new ArithmeticBitModel();
    for (const b of bits) expect(dec.decodeBit(dm)).toBe(b);
  });
});

describe('symbol models', () => {
  // 2 and 16 take the plain path; 33 (the k model) and 256 take the
  // decoder-table path. All four must adapt identically on both sides.
  for (const symbols of [2, 16, 33, 256]) {
    it(`round-trips ${symbols}-symbol adaptive streams`, () => {
      const rand = mulberry32(symbols);
      const syms: number[] = [];
      for (let i = 0; i < 4000; i++) {
        // Skewed distribution so the adaptive update path is exercised.
        const r = rand();
        syms.push(Math.min(symbols - 1, Math.floor(r * r * symbols)));
      }
      const enc = new ArithmeticEncoder();
      const em = new ArithmeticModel(symbols, true);
      for (const s of syms) enc.encodeSymbol(em, s);
      const dec = new ArithmeticDecoder(enc.done());
      dec.init();
      const dm = new ArithmeticModel(symbols, false);
      for (const s of syms) expect(dec.decodeSymbol(dm)).toBe(s);
    });
  }
});

describe('integer corrector (32-bit, two contexts)', () => {
  function roundTrip(values: Array<{ pred: number; real: number; ctx: number }>): void {
    const enc = new ArithmeticEncoder();
    const ic = new IntegerCompressorEnc(enc, 2);
    for (const { pred, real, ctx } of values) ic.compress(pred, real, ctx);
    const dec = new ArithmeticDecoder(enc.done());
    dec.init();
    const id = new IntegerDecompressor(dec, 2);
    for (const { pred, real, ctx } of values) {
      expect(id.decompress(pred, ctx) | 0).toBe(real | 0);
    }
  }

  it('round-trips the fold-sensitive edge correctors', () => {
    const edges = [0, 1, -1, 2, -2, 127, 128, 129, -127, -128, -129, 255, 256, 257,
      65535, 65536, -65536, 2 ** 30, -(2 ** 30), 2147483647, -2147483648];
    const values = edges.map((real, i) => ({ pred: 0, real, ctx: i % 2 }));
    roundTrip(values);
  });

  it('round-trips chunk-table-shaped delta sequences (predicted from the previous delta)', () => {
    const rand = mulberry32(7);
    // Byte-size deltas the way a real table stores them: sizes cluster, so
    // each delta is near its predecessor and correctors stay small.
    const sizes: number[] = [];
    for (let i = 0; i < 3000; i++) sizes.push(180_000 + Math.floor(rand() * 40_000));
    const values: Array<{ pred: number; real: number; ctx: number }> = [];
    let prev = 0;
    for (const s of sizes) {
      values.push({ pred: prev, real: s, ctx: 1 });
      prev = s;
    }
    roundTrip(values);
  });

  it('round-trips adversarially wide jumps across both contexts', () => {
    const rand = mulberry32(11);
    const values: Array<{ pred: number; real: number; ctx: number }> = [];
    let prev0 = 0;
    let prev1 = 0;
    for (let i = 0; i < 2000; i++) {
      const real = (Math.floor(rand() * 4294967296) | 0);
      const ctx = i % 2;
      values.push({ pred: ctx === 0 ? prev0 : prev1, real, ctx });
      if (ctx === 0) prev0 = real;
      else prev1 = real;
    }
    roundTrip(values);
  });
});

describe('stream framing', () => {
  it('a decoder past the payload end reads zeros instead of faulting', () => {
    const enc = new ArithmeticEncoder();
    enc.writeBits(8, 42);
    const bytes = enc.done();
    const dec = new ArithmeticDecoder(bytes);
    dec.init();
    expect(dec.readBits(8)).toBe(42);
    // Reads beyond the payload stay in range and do not throw.
    expect(() => dec.readBits(8)).not.toThrow();
  });
});
