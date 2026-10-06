/**
 * reportSignature.test.ts
 *
 * What these tests would catch:
 *  - A signature that verifies after the body, the signature or the key id was
 *    edited, or after being copied onto another report.
 *  - A valid signature from an unknown key reading as trusted.
 *  - A malformed, truncated, oversize or unsupported signature field crashing
 *    the verifier or passing.
 *  - An unsigned report reading differently from before.
 *  - Private key material reaching a report, the public-key text or an error.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  REPORT_SIGNATURE_ALGORITHM,
  cleanSignerLabel,
  publicKeyThumbprint,
  signReportManifest,
  trustedKeyIdFrom,
  hasRepeatedMemberName,
  parseSignedAt,
  SigningError,
  verifyReportSignature,
  type SigningKey,
} from '../src/export/reportSignature';
import {
  createSigningKey,
  loadSigningKey,
  publicKeyText,
  deleteSigningKey,
  type SigningKeyBackend,
  type StoredSigningKey,
} from '../src/export/reportSigningKeyStore';
import { signReportText } from '../src/export/measurementReport';
import { canonicalize } from '../src/render/measure/auditLog';
import { verifyReportFile, verifyReportFileWithSignature } from '../src/export/verifyReport';
import { buildReportManifest, verifyReportManifest, type ReportManifestInput } from '../src/render/measure/reportManifest';

function memoryBackend(): SigningKeyBackend & { rec: StoredSigningKey | null } {
  const b = {
    rec: null as StoredSigningKey | null,
    async load() { return b.rec; },
    async add(r: StoredSigningKey) { if (b.rec) return false; b.rec = r; return true; },
    async clear() { b.rec = null; },
  };
  return b;
}

function input(over: Partial<ReportManifestInput> = {}): ReportManifestInput {
  return {
    dataset: { id: 'site-a', crs: 'EPSG:6433', pointCount: 4_200_000 },
    generatedAt: '2026-06-29T00:00:00Z',
    classificationEpoch: 3,
    software: '0.7.0',
    findings: [{ label: 'Stockpile volume', value: 1254, unit: 'm³', sigma: 41, confidence: 'medium' }],
    ...over,
  };
}

const OPTS = { signedAt: '2026-10-05T10:00:00.000Z', software: '0.7.0', signerLabel: 'A. Surveyor' };
let key: SigningKey;
let other: SigningKey;

beforeEach(async () => {
  key = await createSigningKey('t', memoryBackend());
  other = await createSigningKey('t', memoryBackend());
});

async function signed(over: Partial<ReportManifestInput> = {}, k: SigningKey = key) {
  return signReportManifest(buildReportManifest(input(over)), k, OPTS, canonicalize);
}

describe('WebCrypto in the test runtime', () => {
  it('is available through globalThis.crypto.subtle', () => {
    expect(globalThis.crypto?.subtle).toBeDefined();
  });
});

describe('sign and verify', () => {
  it('round-trips and reads as an unverified signer without a supplied key', async () => {
    const m = await signed();
    const v = await verifyReportSignature(JSON.parse(JSON.stringify(m)), canonicalize);
    expect(v.status).toBe('valid-unknown-signer');
    expect(v.signatureValid).toBe(true);
    expect(v.keyId).toBe(key.keyId);
    expect(v.signerLabelUnverified).toBe('A. Surveyor');
    expect(v.reason).toMatch(/^Anyone can produce this with their own key/);
    expect(v.reason).toMatch(/not who holds that key/);
    expect(v.reason).not.toMatch(/trusted/i);
    expect(m.reportSignature.algorithm).toBe(REPORT_SIGNATURE_ALGORITHM);
  });

  it('keeps the unkeyed digest valid: signing does not change the digest', async () => {
    const plain = buildReportManifest(input());
    const m = await signReportManifest(plain, key, OPTS, canonicalize);
    expect(m.digest).toBe(plain.digest);
    expect(verifyReportManifest(JSON.parse(JSON.stringify(m)))).toBe(true);
  });

  it('survives pretty printing and a parse round trip', async () => {
    const text = JSON.stringify(await signed(), null, 2);
    const r = await verifyReportFileWithSignature(text);
    expect(r.valid).toBe(true);
    expect(r.signature?.status).toBe('valid-unknown-signer');
  });

  it('reads as the supplied key when the key id matches', async () => {
    const m = await signed();
    const id = await trustedKeyIdFrom(publicKeyText(key));
    expect((await verifyReportSignature(m, canonicalize, id)).status).toBe('valid-trusted-key');
    const byId = await trustedKeyIdFrom(key.keyId);
    expect((await verifyReportSignature(m, canonicalize, byId)).status).toBe('valid-trusted-key');
  });

  it('reads a different supplied key as a different signer, never as trusted', async () => {
    const m = await signed();
    const v = await verifyReportSignature(m, canonicalize, await trustedKeyIdFrom(publicKeyText(other)));
    expect(v.status).toBe('valid-different-key');
    expect(v.signatureValid).toBe(true);
    expect(v.reason).toMatch(/different key/i);
  });

  it('strips control characters and caps the signer label', () => {
    expect(cleanSignerLabel('  a\u0000b\n c  ')).toBe('a b c');
    expect(cleanSignerLabel('x'.repeat(500))).toHaveLength(80);
  });
});

describe('tamper detection', () => {
  const clone = async () => JSON.parse(JSON.stringify(await signed())) as Record<string, any>;

  it('fails when one digit of the body changes', async () => {
    const m = await clone();
    m.findings[0].value = 1255;
    const v = await verifyReportSignature(m, canonicalize);
    expect(v.status).toBe('invalid');
    expect(v.signatureValid).toBe(false);
  });

  it('fails when the body changes and the unkeyed digest is recomputed', async () => {
    const forged = buildReportManifest(input({ findings: [{ label: 'Stockpile volume', value: 9999, unit: 'm³' }] }));
    const m = { ...(await clone()), ...forged, reportSignature: (await clone()).reportSignature };
    const r = await verifyReportFileWithSignature(JSON.stringify(m));
    // The digest matches the forged body; the signature does not.
    expect(verifyReportFile(JSON.stringify(m)).valid).toBe(true);
    expect(r.valid).toBe(false);
    expect(r.signature?.status).toBe('invalid');
  });

  it('fails when one character of the signature changes', async () => {
    const m = await clone();
    const s: string = m.reportSignature.signature;
    m.reportSignature.signature = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect((await verifyReportSignature(m, canonicalize)).status).toBe('invalid');
  });

  it('fails when the key id changes', async () => {
    const m = await clone();
    const id: string = m.reportSignature.keyId;
    m.reportSignature.keyId = (id[0] === 'A' ? 'B' : 'A') + id.slice(1);
    expect((await verifyReportSignature(m, canonicalize)).status).toBe('invalid');
  });

  it('fails when the embedded public key is swapped for another key', async () => {
    const m = await clone();
    m.reportSignature.publicKey = other.publicKey;
    expect((await verifyReportSignature(m, canonicalize)).status).toBe('invalid');
  });

  it('fails when the signed time or label is edited', async () => {
    const a = await clone();
    a.reportSignature.signedAt = '2020-01-01T00:00:00.000Z';
    expect((await verifyReportSignature(a, canonicalize)).status).toBe('invalid');
    const b = await clone();
    b.reportSignature.signerLabel = 'Someone Else';
    expect((await verifyReportSignature(b, canonicalize)).status).toBe('invalid');
  });

  it('fails when the signature is replayed onto another report', async () => {
    const a = await clone();
    const otherBody = JSON.parse(JSON.stringify(await signed({ generatedAt: '2026-07-01T00:00:00Z' }, other)));
    otherBody.reportSignature = a.reportSignature;
    const v = await verifyReportSignature(otherBody, canonicalize);
    expect(v.signatureValid).toBe(false);
  });

  it('fails when a different key signs the same bytes but the block is relabelled', async () => {
    const a = await clone();
    const b = JSON.parse(JSON.stringify(await signed({}, other)));
    a.reportSignature = { ...b.reportSignature, keyId: a.reportSignature.keyId, publicKey: a.reportSignature.publicKey };
    expect((await verifyReportSignature(a, canonicalize)).signatureValid).toBe(false);
  });
});

describe('fail closed on a bad signature field', () => {
  const base = async () => JSON.parse(JSON.stringify(await signed())) as Record<string, any>;

  it('rejects a truncated signature', async () => {
    const m = await base();
    m.reportSignature.signature = m.reportSignature.signature.slice(0, 40);
    const v = await verifyReportSignature(m, canonicalize);
    expect(v.signatureValid).toBe(false);
    expect(v.reason).toMatch(/wrong length/i);
  });

  it('rejects an unsupported algorithm and an unsupported version', async () => {
    const a = await base();
    a.reportSignature.algorithm = 'Ed25519';
    expect((await verifyReportSignature(a, canonicalize)).status).toBe('unsupported');
    const b = await base();
    b.reportSignature.version = 2;
    expect((await verifyReportSignature(b, canonicalize)).status).toBe('unsupported');
  });

  it('rejects oversize, empty, mistyped and unknown members', async () => {
    for (const edit of [
      (b: any) => { b.signerLabel = 'x'.repeat(5000); },
      (b: any) => { b.signedAt = ''; },
      (b: any) => { b.keyId = 12; },
      (b: any) => { b.extra = 'x'; },
      (b: any) => { delete b.signature; },
      (b: any) => { b.publicKey = { kty: 'EC', crv: 'P-384', x: 'a', y: 'b' }; },
      (b: any) => { b.publicKey = { ...b.publicKey, d: 'secret' }; },
      (b: any) => { b.signature = 'x'.repeat(10_000_000); },
    ]) {
      const m = await base();
      edit(m.reportSignature);
      const v = await verifyReportSignature(m, canonicalize);
      expect(v.signatureValid).toBe(false);
      expect(['malformed', 'invalid', 'unsupported']).toContain(v.status);
    }
  });

  it('rejects a signature field that is not an object', async () => {
    for (const bad of [null, 'x', 7, [], true]) {
      const m = await base();
      m.reportSignature = bad;
      const v = await verifyReportSignature(m, canonicalize);
      expect(v.signatureValid).toBe(false);
    }
  });

  it('never throws on arbitrary input and fails the report', async () => {
    for (const text of ['{', '', 'null', '[]', '{"digest":"x","findings":[],"reportSignature":{"version":1}}']) {
      const r = await verifyReportFileWithSignature(text);
      expect(r.valid).toBe(false);
    }
  });

  it('fails the whole report when the signature is bad and the digest matches', async () => {
    const m = await base();
    m.reportSignature.signature = 'A'.repeat(86);
    const r = await verifyReportFileWithSignature(JSON.stringify(m));
    expect(r.recognised).toBe(true);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/does not verify/i);
  });

  it('says so when the supplied key text is not a key', async () => {
    const r = await verifyReportFileWithSignature(JSON.stringify(await signed()), 'not a key');
    expect(r.valid).toBe(true);
    expect(r.signature?.status).toBe('valid-unknown-signer');
    expect(r.signature?.reason).toMatch(/not a P-256 public key/i);
  });
});

describe('unsigned reports are unchanged', () => {
  it('returns exactly the digest-only result', async () => {
    const text = JSON.stringify(buildReportManifest(input()));
    const a = verifyReportFile(text);
    const b = await verifyReportFileWithSignature(text);
    expect(b).toEqual(a);
    expect(b.signature).toBeUndefined();
    expect(b.reason).toMatch(/anyone can recompute/i);
    expect((await verifyReportSignature(JSON.parse(text), canonicalize)).status).toBe('none');
  });

  it('still fails an edited unsigned report on the digest', async () => {
    const m = JSON.parse(JSON.stringify(buildReportManifest(input())));
    m.findings[0].value = 1;
    expect((await verifyReportFileWithSignature(JSON.stringify(m))).valid).toBe(false);
  });
});

describe('key handling', () => {
  it('creates a non-extractable key and reuses it', async () => {
    const b = memoryBackend();
    const k1 = await createSigningKey('t', b);
    const k2 = await createSigningKey('t', b);
    expect(k2.keyId).toBe(k1.keyId);
    expect(b.rec?.privateKey.extractable).toBe(false);
    await expect(globalThis.crypto.subtle.exportKey('jwk', b.rec!.privateKey)).rejects.toThrow();
    expect((await loadSigningKey(b))?.keyId).toBe(k1.keyId);
    await deleteSigningKey(b);
    expect(await loadSigningKey(b)).toBeNull();
  });

  it('computes the RFC 7638 thumbprint of the public key', async () => {
    expect(await publicKeyThumbprint(key.publicKey)).toBe(key.keyId);
  });

  it('signReportText refuses when no key exists', async () => {
    await expect(signReportText('{"digest":"x"}', OPTS, memoryBackend())).rejects.toThrow(/no signing key/i);
  });

  it('signReportText signs the exported text', async () => {
    const b = memoryBackend();
    await createSigningKey('t', b);
    const out = await signReportText(JSON.stringify(buildReportManifest(input()), null, 2), OPTS, b);
    expect((await verifyReportFileWithSignature(out)).signature?.status).toBe('valid-unknown-signer');
  });
});

describe('no private key material in any export', () => {
  it('keeps the private scalar out of the report, the key text and errors', async () => {
    const b = memoryBackend();
    const k = await createSigningKey('t', b);
    // A throwaway extractable key with the same curve is used only to learn what
    // a private JWK looks like; the stored key itself cannot be exported.
    const probe = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const probeJwk = await globalThis.crypto.subtle.exportKey('jwk', probe.privateKey);
    expect(probeJwk.d).toBeDefined();

    const text = await signReportText(JSON.stringify(buildReportManifest(input())), OPTS, b);
    const pub = publicKeyText(k);
    for (const out of [text, pub]) {
      expect(out).not.toMatch(/"d"\s*:/);
      expect(out).not.toMatch(/privateKey|private_key|PRIVATE KEY/i);
    }
    expect(Object.keys(JSON.parse(pub)).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(Object.keys(JSON.parse(text).reportSignature.publicKey).sort()).toEqual(['crv', 'kty', 'x', 'y']);

    let message = '';
    try { await signReportText('not json', OPTS, b); } catch (e) { message = String((e as Error).message); }
    expect(message).not.toMatch(/"d"|privateKey/i);
  });
});

// ── findings from review: forms of one signed report that must not verify ──

describe('only the signed report verifies, not other spellings of its signature or members', () => {
  const textOf = async (pretty = false) => JSON.stringify(await signed(), null, pretty ? 2 : 0);
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  it('still verifies the same values written with other whitespace, key order, escapes and number spellings', async () => {
    const parsed = JSON.parse(await textOf()) as Record<string, unknown>;
    const reversed = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()), null, 4);
    expect((await verifyReportFileWithSignature(reversed)).valid).toBe(true);
    const spelled = (await textOf()).replace('4200000', '4.2e6').replace('1254', '1254.0').replace('"site-a"', '"\\u0073ite-a"');
    expect(spelled).toContain('4.2e6');
    expect((await verifyReportFileWithSignature(spelled)).valid).toBe(true);
  });

  it('rejects a signature whose last base64url character has other spare bits', async () => {
    const m = JSON.parse(await textOf());
    const sig: string = m.reportSignature.signature;
    const i = B64.indexOf(sig[sig.length - 1]!);
    // The last character carries 2 data bits and 4 spare bits; change only the spare bits.
    const alt = B64[(i & 0b110000) | ((i + 1) & 0b001111)]!;
    expect(alt).not.toBe(sig[sig.length - 1]);
    m.reportSignature.signature = sig.slice(0, -1) + alt;
    const v = await verifyReportSignature(m, canonicalize);
    expect(v.signatureValid).toBe(false);
    expect(v.reason).toMatch(/canonical/i);
  });

  it('rejects the high-s form (r, n - s) of a valid signature', async () => {
    const m = JSON.parse(await textOf());
    const raw = Uint8Array.from(atob(m.reportSignature.signature.replace(/-/g, '+').replace(/_/g, '/') + '=='), (c) => c.charCodeAt(0));
    const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
    let sv = 0n;
    for (const x of raw.subarray(32)) sv = (sv << 8n) | BigInt(x);
    expect(sv <= N >> 1n).toBe(true); // the signer made low-s
    const high = new Uint8Array(raw);
    let f = N - sv;
    for (let k = 63; k >= 32; k--) { high[k] = Number(f & 0xffn); f >>= 8n; }
    let bin = ''; for (const x of high) bin += String.fromCharCode(x);
    m.reportSignature.signature = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const v = await verifyReportSignature(m, canonicalize);
    expect(v.signatureValid).toBe(false);
    expect(v.reason).toMatch(/low-s/i);
  });

  it('rejects an extra member inside the embedded public key', async () => {
    const m = JSON.parse(await textOf());
    m.reportSignature.publicKey.ext = true;
    expect((await verifyReportSignature(m, canonicalize)).signatureValid).toBe(false);
    const k = JSON.parse(await textOf());
    k.reportSignature.publicKey.key_ops = ['verify'];
    expect((await verifyReportSignature(k, canonicalize)).status).toBe('malformed');
  });

  it('rejects a repeated member name at the top level, in the block and nested', async () => {
    const t = await textOf();
    const fake = '"findings":[{"label":"Stockpile volume","value":9999,"unit":"m³"}],';
    // JSON.parse keeps the last copy, so a parse-based check shows the real figures as Signed.
    const first = '{' + fake + t.slice(1);
    expect(JSON.parse(first).findings[0].value).toBe(1254);
    for (const text of [
      first,
      t.replace('"reportSignature":{', '"reportSignature":{"signerLabel":"Other",'),
      t.replace('"dataset":{', '"dataset":{"id":"fake",'),
    ]) {
      const r = await verifyReportFileWithSignature(text);
      expect(r.valid).toBe(false);
      expect(r.signature?.status).toBe('malformed');
      expect(r.reason).toMatch(/repeat/i);
    }
  });

  it('finds repeats at any depth, ignores names inside strings and values, and survives deep nesting', () => {
    expect(hasRepeatedMemberName('{"a":1,"a":2}')).toBe(true);
    expect(hasRepeatedMemberName('{"a":{"b":1,"b":2}}')).toBe(true);
    expect(hasRepeatedMemberName('{"a":[{"b":1},{"b":2}]}')).toBe(false);
    expect(hasRepeatedMemberName('{"a":"\\"a\\":1","b":"a"}')).toBe(false);
    expect(hasRepeatedMemberName('{"a":1,"\\u0061":2}')).toBe(true);
    expect(hasRepeatedMemberName('['.repeat(30_000) + ']'.repeat(30_000))).toBe(false);
  });

  it('rejects a signed time that is not a UTC timestamp and shows the time normalised', async () => {
    const m = JSON.parse(await textOf());
    m.reportSignature.signedAt = '1';
    expect((await verifyReportSignature(m, canonicalize)).status).toBe('malformed');
    expect((await verifyReportSignature(JSON.parse(await textOf()), canonicalize)).signedAtClaim).toBe(OPTS.signedAt);
  });

  it('reads signed times the same in every engine, with explicit range checks', async () => {
    expect(parseSignedAt('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseSignedAt('2026-13-01T00:00:00Z')).toBeNull();
    expect(parseSignedAt('2026-00-10T00:00:00Z')).toBeNull();
    expect(parseSignedAt('2026-01-01T24:00:00Z')).toBeNull();
    expect(parseSignedAt('2026-01-01T00:60:00Z')).toBeNull();
    expect(parseSignedAt('2026-01-01T00:00:60Z')).toBeNull();
    expect(parseSignedAt('2026-04-31T00:00:00Z')).toBeNull();
    expect(parseSignedAt('2025-02-29T00:00:00Z')).toBeNull();
    expect(parseSignedAt('2024-02-29T00:00:00Z')).toBe('2024-02-29T00:00:00.000Z');
    expect(parseSignedAt('2000-02-29T12:30:45.5Z')).toBe('2000-02-29T12:30:45.500Z');
    expect(parseSignedAt('1900-02-29T00:00:00Z')).toBeNull();
    for (const bad of ['2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z']) {
      const m = JSON.parse(await textOf());
      m.reportSignature.signedAt = bad;
      const v = await verifyReportSignature(m, canonicalize);
      expect(v.status).toBe('malformed');
    }
  });

  it('strips bidi and zero-width characters from a label', () => {
    expect(cleanSignerLabel('a\u202Eb\u200Bc\u2066d')).toBe('a b c d');
  });
});

describe('a hostile report is a result, not an exception', () => {
  it('returns a clear result for 1e999 and for deep nesting', async () => {
    const inf = '{"digest":"x","digestAlgorithm":"SHA-256","findings":[{"value":1e999}]}';
    const deep = '{"digest":"x","digestAlgorithm":"SHA-256","findings":[' + '['.repeat(30_000) + ']'.repeat(30_000) + ']}';
    for (const text of [inf, deep]) {
      const r = await verifyReportFileWithSignature(text);
      expect(r.valid).toBe(false);
      expect(r.reason.length).toBeGreaterThan(10);
    }
    expect((await verifyReportFileWithSignature(inf)).reason).toMatch(/cannot be checked/i);
  });
});

describe('creating the key', () => {
  it('ends with one key when two tabs create at once', async () => {
    const b = memoryBackend();
    const [a, c] = await Promise.all([createSigningKey('t', b), createSigningKey('t', b)]);
    expect(a.keyId).toBe(c.keyId);
    expect((await loadSigningKey(b))?.keyId).toBe(a.keyId);
  });
  it('says the cause when no key exists', async () => {
    await expect(signReportText('{"digest":"x"}', OPTS, memoryBackend())).rejects.toBeInstanceOf(SigningError);
  });
});
