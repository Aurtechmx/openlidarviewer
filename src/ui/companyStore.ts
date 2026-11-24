/**
 * companyStore.ts: the company, logo and people remembered on this device,
 * only when the user asks for it. Never part of a session file.
 */
import { cleanCompany, isEmptyFields, type CompanyDetails } from '../model/deliverableFields';
import { storageGet, storageRemove, storageSet } from './safeStorage';

const KEY = 'olv.deliverable.company:v1';

/** What this device remembers, or null when it remembers nothing. */
export function rememberedCompany(): CompanyDetails | null {
  const raw = storageGet(KEY);
  if (raw === null) return null;
  try {
    const v = cleanCompany(JSON.parse(raw));
    return isEmptyFields(v) ? null : v;
  } catch {
    return null;
  }
}

/** Remember `details` on this device, or forget what it remembered (null). True when the device now holds it. */
export function rememberCompany(details: CompanyDetails | null): boolean {
  if (details === null || isEmptyFields(details)) {
    storageRemove(KEY);
    return false;
  }
  const s = JSON.stringify(cleanCompany(details));
  storageSet(KEY, s);
  // The write is best effort; a full or blocked store keeps nothing.
  return storageGet(KEY) === s;
}
