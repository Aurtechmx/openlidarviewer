/**
 * reportSigningKeyStore.ts
 *
 * Holds the browser's report-signing key. The private key is generated
 * non-extractable and stays a CryptoKey object from creation to use: it is
 * stored in IndexedDB by structured clone, and no code path reads its bytes, so
 * it cannot appear in a file, a log or an error message. The key lives in this
 * browser profile only; clearing site data deletes it.
 *
 * No network access, no key upload. The backend is injectable so tests run
 * without IndexedDB.
 */

import { publicKeyThumbprint, toPublicKeyJwk, type PublicKeyJwk, type SigningKey } from './reportSignature';

export interface StoredSigningKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: PublicKeyJwk;
  readonly keyId: string;
  readonly createdAt: string;
}

export interface SigningKeyBackend {
  load(): Promise<StoredSigningKey | null>;
  save(record: StoredSigningKey): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'olv-report-signing';
const STORE = 'keys';
const RECORD = 'default';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error('The signing-key store could not be opened.'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(new Error('The signing-key store failed.'));
      tx.onabort = () => reject(new Error('The signing-key store failed.'));
    });
  } finally {
    db.close();
  }
}

/** The IndexedDB backend used by the app. */
export const indexedDbBackend: SigningKeyBackend = {
  async load() {
    const rec = await run<unknown>('readonly', (s) => s.get(RECORD));
    return isStoredKey(rec) ? rec : null;
  },
  async save(record) {
    await run('readwrite', (s) => s.put(record, RECORD));
  },
  async clear() {
    await run('readwrite', (s) => s.delete(RECORD));
  },
};

function isStoredKey(v: unknown): v is StoredSigningKey {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<StoredSigningKey>;
  return typeof r.keyId === 'string' && typeof r.createdAt === 'string' && !!r.privateKey && typeof r.privateKey === 'object' && r.privateKey.extractable === false && !!r.publicKey;
}

/** The existing key, or null when none was created in this profile. */
export async function loadSigningKey(backend: SigningKeyBackend = indexedDbBackend): Promise<SigningKey | null> {
  const rec = await backend.load();
  return rec ? { privateKey: rec.privateKey, publicKey: rec.publicKey, keyId: rec.keyId } : null;
}

/** Create and store a new key. Replaces any existing one only when `replace` is set. */
export async function createSigningKey(
  createdAt: string,
  backend: SigningKeyBackend = indexedDbBackend,
  replace = false,
): Promise<SigningKey> {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available.');
  if (!replace) {
    const existing = await loadSigningKey(backend);
    if (existing) return existing;
  }
  const pair = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = toPublicKeyJwk(await s.exportKey('jwk', pair.publicKey));
  if (!jwk) throw new Error('The generated key was not a P-256 key.');
  const keyId = await publicKeyThumbprint(jwk);
  await backend.save({ privateKey: pair.privateKey, publicKey: jwk, keyId, createdAt });
  return { privateKey: pair.privateKey, publicKey: jwk, keyId };
}

/** Delete the stored key. */
export async function deleteSigningKey(backend: SigningKeyBackend = indexedDbBackend): Promise<void> {
  await backend.clear();
}

/** The public key as the text "Copy public key" puts on the clipboard. */
export function publicKeyText(key: { readonly publicKey: PublicKeyJwk }): string {
  return JSON.stringify({ kty: key.publicKey.kty, crv: key.publicKey.crv, x: key.publicKey.x, y: key.publicKey.y });
}
