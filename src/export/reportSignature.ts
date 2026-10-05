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

function fromBase64Url(text: string): Uint8Array | null {
  if (!B64URL.test(text)) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
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

function isPublicKeyJwk(v: unknown): v is PublicKeyJwk {
  if (typeof v !== 'object' || v === null) return false;
  const k = v as Record<string, unknown>;
  return (
    k.kty === 'EC' && k.crv === 'P-256' &&
    typeof k.x === 'string' && k.x.length === COORD_LEN && B64URL.test(k.x) &&
    typeof k.y === 'string' && k.y.length === COORD_LEN && B64URL.test(k.y)
  );
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

/** Normalise a signer label: trimmed, control characters removed, length capped. */
export function cleanSignerLabel(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNER_LABEL_CHARS);
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
  const sig = await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, signedBytes(canonicalize, manifest as unknown as Obj, meta) as BufferSource);
  const block: ReportSignatureBlock = {
    version: REPORT_SIGNATURE_VERSION,
    algorithm: REPORT_SIGNATURE_ALGORITHM,
    keyId: key.keyId,
    publicKey: key.publicKey,
    signedAt: opts.signedAt,
    ...(meta.software ? { software: meta.software } : {}),
    ...(label ? { signerLabel: label } : {}),
    digest: manifest.digest,
    signature: toBase64Url(new Uint8Array(sig)),
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
    if (!isPublicKeyJwk(b.publicKey)) return bad('malformed', 'The embedded public key is not a P-256 key.');
    const s = subtle();
    if (!s) return bad('unsupported', 'This browser cannot check signatures (WebCrypto is unavailable).');
    const claim = { keyId: keyId!, signedAtClaim: signedAt!, signerLabelUnverified: label, software };
    if ((await publicKeyThumbprint(b.publicKey)) !== keyId) return bad('invalid', 'The recorded key id does not match the embedded public key.', claim);
    if (sigText!.length !== SIG_LEN) return bad('invalid', 'The signature is the wrong length (truncated or padded).', claim);
    const sigBytes = fromBase64Url(sigText!);
    if (!sigBytes || sigBytes.length !== 64) return bad('invalid', 'The signature is not valid base64url.', claim);
    if (digest !== m.digest) return bad('invalid', 'The report digest changed after signing.', claim);
    const key = await s.importKey('jwk', { ...b.publicKey, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const bytes = signedBytes(canonicalize, m, { algorithm: REPORT_SIGNATURE_ALGORITHM, keyId: keyId!, signedAt: signedAt!, ...(software ? { software } : {}), ...(label ? { signerLabel: label } : {}), digest: digest! });
    const ok = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sigBytes as BufferSource, bytes as BufferSource);
    if (!ok) return bad('invalid', 'The signature does not match this report. The report was edited after signing, or the signature was copied from another report.', claim);
    if (trustedKeyId === undefined || trustedKeyId === null) {
      return { status: 'valid-unknown-signer', signatureValid: true, ...claim, reason: 'The signature is valid for the key inside the report, so the report is unchanged since that key signed it. You have not supplied a key to compare, so the signer is unverified.' };
    }
    if (trustedKeyId === keyId) {
      return { status: 'valid-trusted-key', signatureValid: true, ...claim, reason: 'The signature is valid and was made by the key you supplied. That shows the holder of that key signed it, not who that person is.' };
    }
    return { status: 'valid-different-key', signatureValid: true, ...claim, reason: 'The signature is valid, but it was made by a different key from the one you supplied. Treat the signer as unverified.' };
  } catch {
    return bad('invalid', 'The signature could not be checked.');
  }
}
