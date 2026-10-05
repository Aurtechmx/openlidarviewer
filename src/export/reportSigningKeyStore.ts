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

import { SigningError, publicKeyThumbprint, toPublicKeyJwk, type PublicKeyJwk, type SigningKey } from './reportSignature';

export interface StoredSigningKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: PublicKeyJwk;
  readonly keyId: string;
  readonly createdAt: string;
}

export interface SigningKeyBackend {
  load(): Promise<StoredSigningKey | null>;
  /** Store the record only if none exists. Resolves false when one already does. Atomic. */
  add(record: StoredSigningKey): Promise<boolean>;
  clear(): Promise<void>;
}

const DB_NAME = 'olv-report-signing';
const STORE = 'keys';
const RECORD = 'default';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new SigningError('This browser does not allow key storage here, which private browsing can cause. Turn off "Sign this report" or use a normal window.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new SigningError('This browser would not open its key storage, which private browsing can cause. Turn off "Sign this report" or use a normal window.'));
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
  async add(record) {
    const db = await openDb();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).add(record, RECORD);
        let exists = false;
        req.onerror = (e) => {
          // add() fails with ConstraintError when the record id is taken, which
          // is another tab having created its key first.
          if (req.error?.name === 'ConstraintError') { exists = true; e.preventDefault(); }
        };
        tx.oncomplete = () => resolve(!exists);
        tx.onerror = () => reject(new Error('store'));
        tx.onabort = () => (exists ? resolve(false) : reject(new Error('store')));
      });
    } finally {
      db.close();
    }
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

/**
 * Create and store the key, or return the one that exists. The store is written
 * with an add that fails when a record exists, so two tabs creating at once end
 * with one key: the loser discards its own and returns the winner's.
 */
export async function createSigningKey(
  createdAt: string,
  backend: SigningKeyBackend = indexedDbBackend,
): Promise<SigningKey> {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new SigningError('This browser cannot sign reports.');
  const existing = await loadSigningKey(backend);
  if (existing) return existing;
  const pair = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const jwk = toPublicKeyJwk(await s.exportKey('jwk', pair.publicKey));
  if (!jwk) throw new SigningError('The generated key was not usable.');
  const keyId = await publicKeyThumbprint(jwk);
  const stored = await backend.add({ privateKey: pair.privateKey, publicKey: jwk, keyId, createdAt });
  if (!stored) {
    const winner = await loadSigningKey(backend);
    if (winner) return winner;
    throw new SigningError('The signing key could not be saved. Try again.');
  }
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
