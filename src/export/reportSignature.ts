/**
 * reportSignature.ts
 *
 * An optional keyed signature over an integrity report.
 *
 * The report's own digest is unkeyed: anyone who edits a figure can recompute
 * it. A signature closes that one gap. It lets a reader detect any edit made
 * after signing, and tell whether the same key signed two reports. It does not
 * say who the key belongs to, when the report was signed, which source file it
 * came from, or whether the numbers are right (see docs/threat-model.md).
 *
 * Algorithm: ECDSA P-256 with SHA-256 through WebCrypto (`crypto.subtle`), in
 * the IEEE P1363 (r || s) form WebCrypto produces. The signed bytes are the
 * UTF-8 of a domain tag, a canonical metadata object (algorithm id, key id,
 * signer's claimed time, app version, signer label, the report digest), and
 * the same canonical report body the digest already covers. The signature
 * block itself is outside both the digest and the signed bytes.
 *
 * Pure of the DOM. Every verifier path returns a verdict; none throws. The
 * report's canonical serializer (`canonicalize`, the one the digest uses) is
 * passed in by the callers that already sit beside the report layer, so this
 * module adds no dependency edge of its own.
 */

/** The report layer's canonical, key-sorted serializer. */
export type Canonicalize = (value: unknown) => string;


/** Name of the manifest field that carries the signature block. */
export const REPORT_SIGNATURE_FIELD = 'reportSignature';
export const REPORT_SIGNATURE_VERSION = 1;
export const REPORT_SIGNATURE_ALGORITHM = 'ECDSA-P256-SHA256';

const DOMAIN_TAG = 'OLV-REPORT-SIGNATURE-1';
const B64URL = /^[A-Za-z0-9_-]+$/;
/** A P-256 coordinate and a SHA-256 thumbprint are both 43 base64url characters. */
const COORD_LEN = 43;
/** A 64-byte raw P-256 signature is 86 base64url characters. */
const SIG_LEN = 86;
export const MAX_SIGNER_LABEL_CHARS = 80;

/** A signing failure whose message is written for the user and carries no key material. */
export class SigningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningError';
  }
}

// P-256 group order and half of it. A signature is made and accepted only with s <= n/2,
// so (r, n - s), which also verifies, is not a second valid form of the same signature.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N >> 1n;
const SIGNED_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

/**
 * Parse a signed time as UTC with explicit range checks, so every engine reads
 * a given string the same way (`Date.parse` rolls 2026-02-30 over in V8 and
 * returns NaN in Firefox and Safari). Returns the normalised ISO time or null.
 */
export function parseSignedAt(text: string): string | null {
  const m = SIGNED_AT.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (mo < 1 || mo > 12 || d < 1 || d > days! || h > 23 || mi > 59 || se > 59) return null;
  const ms = Number((m[7] ?? '').padEnd(3, '0') || 0);
  // `Date.UTC` reads years 0 to 99 as 1900 to 1999; set the year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, se, ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
const MAX_SHORT_FIELD_CHARS = 64;

/** The public half of the signing key, as a JSON Web Key. */
export interface PublicKeyJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly x: string;
  readonly y: string;
}

export interface ReportSignatureBlock {
  readonly version: number;
  readonly algorithm: string;
  /** RFC 7638 thumbprint of `publicKey`. */
  readonly keyId: string;
  readonly publicKey: PublicKeyJwk;
  /** The signer's own clock. A claim, not proof of when signing happened. */
  readonly signedAt: string;
  readonly software?: string;
  /** Free text the signer typed. Not verified. */
  readonly signerLabel?: string;
  /** The report digest at signing time. */
  readonly digest: string;
  /** base64url of the raw 64-byte signature. */
  readonly signature: string;
}

export type SignatureStatus =
  | 'none'
  | 'valid-unknown-signer'
  | 'valid-trusted-key'
  | 'valid-different-key'
  | 'invalid'
  | 'malformed'
  | 'unsupported';

export interface SignatureVerdict {
  readonly status: SignatureStatus;
  /** True only when the signature verified for the embedded key. */
  readonly signatureValid: boolean;
  readonly keyId?: string;
  readonly signedAtClaim?: string;
  readonly signerLabelUnverified?: string;
  readonly software?: string;
  readonly reason: string;
}

// ── base64url ────────────────────────────────────────────────────────────

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode base64url, refusing any spelling that does not re-encode to the same text. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!B64URL.test(text)) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return toBase64Url(out) === text ? out : null;
  } catch {
    return null;
  }
}

function subtle(): SubtleCrypto | null {
  return globalThis.crypto?.subtle ?? null;
}

/** True when WebCrypto can sign here. */
export function signingAvailable(): boolean {
  return subtle() !== null;
}

// ── key identity ─────────────────────────────────────────────────────────

/** RFC 7638 JWK thumbprint (SHA-256) of an EC P-256 public key. */
export async function publicKeyThumbprint(jwk: PublicKeyJwk): Promise<string> {
  const s = subtle();
  if (!s) throw new Error('WebCrypto is not available.');
  const canon = `{"crv":"P-256","kty":"EC","x":${JSON.stringify(jwk.x)},"y":${JSON.stringify(jwk.y)}}`;
  const digest = await s.digest('SHA-256', new TextEncoder().encode(canon));
  return toBase64Url(new Uint8Array(digest));
}

function isCanonicalCoord(v: unknown): v is string {
  return typeof v === 'string' && v.length === COORD_LEN && fromBase64Url(v) !== null;
}

/** With `exact`, the object must hold kty, crv, x and y and nothing else. */
function isPublicKeyJwk(v: unknown, exact = false): v is PublicKeyJwk {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const k = v as Record<string, unknown>;
  if (exact && Object.keys(k).length !== 4) return false;
  return k.kty === 'EC' && k.crv === 'P-256' && isCanonicalCoord(k.x) && isCanonicalCoord(k.y);
}

/** Keep only the four public fields, so extra members never travel. */
export function toPublicKeyJwk(jwk: JsonWebKey): PublicKeyJwk | null {
  const c = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  return isPublicKeyJwk(c) ? c : null;
}

// ── signed bytes ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function signedBytes(canonicalize: Canonicalize, manifest: Obj, meta: { algorithm: string; keyId: string; signedAt: string; software?: string; signerLabel?: string; digest: string }): Uint8Array {
  const { digest: _d, [REPORT_SIGNATURE_FIELD]: _s, ...body } = manifest;
  return new TextEncoder().encode(`${DOMAIN_TAG}\n${canonicalize(meta)}\n${canonicalize(body)}`);
}

function bigFrom(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

/** Return the raw signature in its low-s form. */
function lowS(sig: Uint8Array): Uint8Array {
  const s = bigFrom(sig.subarray(32));
  if (s <= P256_HALF_N) return sig;
  const out = new Uint8Array(64);
  out.set(sig.subarray(0, 32));
  const flipped = P256_N - s;
  for (let i = 63; i >= 32; i--) out[i] = Number((flipped >> BigInt((63 - i) * 8)) & 0xffn);
  return out;
}

// ── signing ──────────────────────────────────────────────────────────────

export interface SigningKey {
  /** Non-extractable. Only ever handed to `subtle.sign`. */
  readonly privateKey: CryptoKey;
  readonly publicKey: PublicKeyJwk;
  readonly keyId: string;
}

export interface SignOptions {
  readonly signedAt: string;
  readonly software?: string;
  readonly signerLabel?: string;
}

/** Normalise a signer label: trimmed, control, bidi and zero-width characters removed, length capped. Used when creating and again when displaying. */
export function cleanSignerLabel(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNER_LABEL_CHARS);
}

/** Return the manifest with a signature block attached. Throws if signing fails. */
export async function signReportManifest<T extends { digest: string }>(manifest: T, key: SigningKey, opts: SignOptions, canonicalize: Canonicalize): Promise<T & { reportSignature: ReportSignatureBlock }> {
  const s = subtle();
  if (!s) throw new Error('WebCrypto is not available.');
  const label = opts.signerLabel ? cleanSignerLabel(opts.signerLabel) : '';
  const meta = {
    algorithm: REPORT_SIGNATURE_ALGORITHM,
    keyId: key.keyId,
    signedAt: opts.signedAt,
    ...(opts.software ? { software: opts.software } : {}),
    ...(label ? { signerLabel: label } : {}),
    digest: manifest.digest,
  };
  const sig = lowS(new Uint8Array(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, signedBytes(canonicalize, manifest as unknown as Obj, meta) as BufferSource)));
  const block: ReportSignatureBlock = {
    version: REPORT_SIGNATURE_VERSION,
    algorithm: REPORT_SIGNATURE_ALGORITHM,
    keyId: key.keyId,
    publicKey: key.publicKey,
    signedAt: opts.signedAt,
    ...(meta.software ? { software: meta.software } : {}),
    ...(label ? { signerLabel: label } : {}),
    digest: manifest.digest,
    signature: toBase64Url(sig),
  };
  return { ...manifest, reportSignature: block };
}

// ── trusted key input ────────────────────────────────────────────────────

/**
 * Read a key the user supplies for comparison: a public-key JSON (the form
 * "Copy public key" produces) or a bare 43-character key id. Returns the key
 * id, or null when the text is neither.
 */
export async function trustedKeyIdFrom(text: string): Promise<string | null> {
  const t = text.trim();
  if (t.length === 0 || t.length > 4096) return null;
  if (t.length === COORD_LEN && B64URL.test(t)) return t;
  try {
    const parsed: unknown = JSON.parse(t);
    const jwk = isPublicKeyJwk(parsed) ? parsed : isPublicKeyJwk((parsed as Obj | null)?.publicKey) ? ((parsed as Obj).publicKey as PublicKeyJwk) : null;
    return jwk ? await publicKeyThumbprint(jwk) : null;
  } catch {
    return null;
  }
}

// ── repeated member names ────────────────────────────────────────────────

/**
 * True when any object in the JSON text repeats a member name, at any depth.
 * `JSON.parse` keeps the last copy, a first-wins parser keeps the first, so a
 * file with a repeat can show different figures to different tools. Iterative,
 * so deep nesting cannot exhaust the stack. Text that is not well formed
 * returns false; the caller's own parse reports that.
 */
export function hasRepeatedMemberName(text: string): boolean {
  const stack: Array<Set<string> | null> = [];
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      if (j >= n) return false;
      const top = stack[stack.length - 1];
      if (expectKey && top) {
        let name: string;
        try { name = JSON.parse(text.slice(i, j + 1)) as string; } catch { return false; }
        if (top.has(name)) return true;
        top.add(name);
        expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === '{') { stack.push(new Set()); expectKey = true; }
    else if (c === '[') { stack.push(null); expectKey = false; }
    else if (c === '}' || c === ']') { stack.pop(); expectKey = false; }
    else if (c === ',') { expectKey = stack[stack.length - 1] instanceof Set; }
    i++;
  }
  return false;
}

// ── verification ─────────────────────────────────────────────────────────

const bad = (status: SignatureStatus, reason: string, extra: Partial<SignatureVerdict> = {}): SignatureVerdict =>
  ({ status, signatureValid: false, reason, ...extra });

/** Allowed members of the block. Anything else makes the field malformed. */
const BLOCK_KEYS = new Set(['version', 'algorithm', 'keyId', 'publicKey', 'signedAt', 'software', 'signerLabel', 'digest', 'signature']);

/**
 * Check the signature on a parsed report. `trustedKeyId` is the key id of a
 * public key the reader supplied; without it a valid signature reads as
 * "unverified signer". Never throws.
 */
export async function verifyReportSignature(manifest: unknown, canonicalize: Canonicalize, trustedKeyId?: string | null): Promise<SignatureVerdict> {
  try {
    if (typeof manifest !== 'object' || manifest === null) return bad('none', 'This report is not signed.');
    const m = manifest as Obj;
    if (!(REPORT_SIGNATURE_FIELD in m)) return { status: 'none', signatureValid: false, reason: 'This report is not signed.' };
    const raw = m[REPORT_SIGNATURE_FIELD];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('malformed', 'The signature field is not an object.');
    const b = raw as Obj;
    if (Object.keys(b).some((k) => !BLOCK_KEYS.has(k))) return bad('malformed', 'The signature field has members this version does not define.');
    if (b.version !== REPORT_SIGNATURE_VERSION) return bad('unsupported', `The signature format version ${typeof b.version === 'number' ? String(b.version) : '(missing)'} is not supported here.`);
    if (b.algorithm !== REPORT_SIGNATURE_ALGORITHM) return bad('unsupported', 'The signature algorithm is not supported here.');
    const str = (k: string, max: number, required: boolean): string | undefined | null => {
      const v = b[k];
      if (v === undefined) return required ? null : undefined;
      return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
    };
    const keyId = str('keyId', COORD_LEN, true);
    const signedAt = str('signedAt', MAX_SHORT_FIELD_CHARS, true);
    const digest = str('digest', 128, true);
    const sigText = str('signature', SIG_LEN, true);
    const software = str('software', MAX_SHORT_FIELD_CHARS, false);
    const label = str('signerLabel', MAX_SIGNER_LABEL_CHARS, false);
    if (keyId === null || signedAt === null || digest === null || sigText === null || software === null || label === null) {
      return bad('malformed', 'The signature field has a missing, empty or oversize member.');
    }
    if (!isPublicKeyJwk(b.publicKey, true)) return bad('malformed', 'The embedded public key is not a plain P-256 key (kty, crv, x and y only).');
    const s = subtle();
    if (!s) return bad('unsupported', 'This browser cannot check signatures (WebCrypto is unavailable).');
    const signedAtIso = parseSignedAt(signedAt!);
    if (signedAtIso === null) return bad('malformed', 'The signed time is not a valid UTC date and time.');
    if (!isCanonicalCoord(keyId)) return bad('malformed', 'The recorded key id is not in its canonical form.');
    // Shown to the reader with control, bidi and zero-width characters removed. The raw text is what was signed.
    const shown = (t: string | undefined): string | undefined => (t === undefined ? undefined : cleanSignerLabel(t) || undefined);
    const claim = { keyId: keyId!, signedAtClaim: signedAtIso, signerLabelUnverified: shown(label), software: shown(software) };
    if ((await publicKeyThumbprint(b.publicKey)) !== keyId) return bad('invalid', 'The recorded key id does not match the embedded public key.', claim);
    if (sigText!.length !== SIG_LEN) return bad('invalid', 'The signature is the wrong length (truncated or padded).', claim);
    const sigBytes = fromBase64Url(sigText!);
    if (!sigBytes || sigBytes.length !== 64) return bad('invalid', 'The signature is not in canonical base64url form.', claim);
    if (bigFrom(sigBytes.subarray(32)) > P256_HALF_N) return bad('invalid', 'The signature is not in its low-s form, so it is not the one that was made.', claim);
    if (digest !== m.digest) return bad('invalid', 'The report digest changed after signing.', claim);
    const key = await s.importKey('jwk', { ...b.publicKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const bytes = signedBytes(canonicalize, m, { algorithm: REPORT_SIGNATURE_ALGORITHM, keyId: keyId!, signedAt: signedAt!, ...(software ? { software } : {}), ...(label ? { signerLabel: label } : {}), digest: digest! });
    const ok = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes as BufferSource, bytes as BufferSource);
    if (!ok) return bad('invalid', 'The signature does not match this report. Its figures or signed metadata changed after signing, or the signature was copied from another report.', claim);
    if (trustedKeyId === undefined || trustedKeyId === null) {
      return { status: 'valid-unknown-signer', signatureValid: true, ...claim, reason: 'Anyone can produce this with their own key. It shows the report is unchanged since the key inside it signed it, not who holds that key. You have not supplied a key to compare.' };
    }
    if (trustedKeyId === keyId) {
      return { status: 'valid-trusted-key', signatureValid: true, ...claim, reason: 'The signature is valid and was made by the key you supplied. That shows the holder of that key signed it, not who that person is.' };
    }
    return { status: 'valid-different-key', signatureValid: true, ...claim, reason: 'The signature is valid, but it was made by a different key from the one you supplied. Treat the signer as unverified.' };
  } catch {
    return bad('invalid', 'The signature could not be checked.');
  }
}
