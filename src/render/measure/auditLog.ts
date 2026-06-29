/**
 * auditLog.ts
 *
 * A tamper-evident, replayable record of what was done to a dataset and what
 * each measurement claimed.
 *
 * Local-first means the data never leaves the machine — but a surveyor staking
 * their name on a number needs more than privacy: they need to prove the number
 * wasn't quietly changed afterwards. This is an append-only hash chain. Each
 * entry's hash folds in the previous entry's hash plus a CANONICAL (stable
 * key-order) serialization of its own contents, so any later edit to any entry
 * — a reclassification logged with the wrong target class, a volume whose ±
 * band was tampered down — breaks the chain from that point on and
 * {@link verifyAuditChain} reports exactly where.
 *
 * Deterministic by construction: the same sequence of appends always yields the
 * same hashes and the same serialization, so two parties can independently
 * verify they hold the same history.
 *
 * The hash function is injectable. The built-in {@link fnv1a} is a fast,
 * deterministic, NON-cryptographic checksum — it catches accidental corruption
 * and casual edits. For cryptographic tamper-evidence, inject a SHA-256 (e.g.
 * via SubtleCrypto, pre-hashing each body) — the chain logic is hash-agnostic.
 */

export type HashFn = (input: string) => string;

/**
 * Stable, key-sorted serialization so a record's hash never depends on the
 * order its fields happened to be written in. Arrays keep their order
 * (it's meaningful); object keys are sorted.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/** FNV-1a 32-bit — deterministic, fast, non-cryptographic. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * SHA-256 over the UTF-8 bytes of `input`, returned as 64-char lowercase hex.
 *
 * A from-scratch, dependency-free, SYNCHRONOUS implementation. WebCrypto's
 * `crypto.subtle.digest` is async, which would force `async` through every
 * `HashFn` caller (`buildReportManifest`, `verifyReportManifest`, the audit
 * chain). Keeping this synchronous preserves the pure, deterministic core the
 * rest of the module relies on while still giving a cryptographic-strength
 * digest. Matches the FIPS-180-4 test vectors (e.g. "abc").
 */
export function sha256(input: string): string {
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
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const bytes = new TextEncoder().encode(input);
  const bitLen = bytes.length * 8;
  const withOne = bytes.length + 1;
  const padK = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padK + 8;
  const msg = new Uint8Array(total);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(total - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const hex = (x: number): string => (x >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

export interface AuditEntry {
  /** Position in the chain, 0-based. */
  readonly seq: number;
  /** What happened, e.g. 'reclassify' | 'measure.volume' | 'export'. */
  readonly type: string;
  /** The payload — edit details, or a measurement value with its uncertainty. */
  readonly data: unknown;
  /** Chain hash: hashFn(prevHash + canonical({seq,type,data})). */
  readonly hash: string;
}

const GENESIS = '0';

export class AuditLog {
  private readonly _entries: AuditEntry[] = [];
  private readonly _hashFn: HashFn;

  constructor(hashFn: HashFn = fnv1a) {
    this._hashFn = hashFn;
  }

  /** Append a record and return it. The chain head advances to its hash. */
  append(type: string, data: unknown): AuditEntry {
    const seq = this._entries.length;
    const prev = seq === 0 ? GENESIS : this._entries[seq - 1].hash;
    const hash = this._hashFn(prev + '|' + canonicalize({ seq, type, data }));
    const entry: AuditEntry = { seq, type, data, hash };
    this._entries.push(entry);
    return entry;
  }

  get entries(): ReadonlyArray<AuditEntry> {
    return this._entries;
  }

  /** The current chain head hash (or the genesis sentinel when empty). */
  get head(): string {
    return this._entries.length === 0 ? GENESIS : this._entries[this._entries.length - 1].hash;
  }

  /** Deterministic, canonical serialization of the whole log for export. */
  serialize(): string {
    return canonicalize({ version: 1, entries: this._entries });
  }
}

/**
 * Recompute the chain over `entries` and return the index of the FIRST entry
 * that is out of order or whose hash doesn't match — i.e. the first point of
 * tampering or corruption. Returns -1 when the chain is fully intact.
 */
export function verifyAuditChain(
  entries: ReadonlyArray<AuditEntry>,
  hashFn: HashFn = fnv1a,
): number {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i) return i;
    const expect = hashFn(prev + '|' + canonicalize({ seq: e.seq, type: e.type, data: e.data }));
    if (expect !== e.hash) return i;
    prev = e.hash;
  }
  return -1;
}
