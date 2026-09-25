/**
 * recoveryStatus.ts — the on/off preference and the one-line state of the
 * session recovery journal.
 *
 * Kept tiny and separate from the journal itself so the Help action and Copy
 * diagnostics can read or flip it without loading the journal chunk.
 */
import { storageGet, storageRemove, storageSet } from '../../ui/safeStorage';

/** localStorage key; the value '1' means the user turned recovery off. */
export const RECOVERY_OFF_KEY = 'olv:recovery:off';

/** Whether the journal may run. Defaults to on; an unreadable store reads as on. */
export function recoveryEnabled(): boolean {
  return storageGet(RECOVERY_OFF_KEY) !== '1';
}

export function setRecoveryEnabled(on: boolean): void {
  if (on) storageRemove(RECOVERY_OFF_KEY);
  else storageSet(RECOVERY_OFF_KEY, '1');
}

let status = 'not-started';

/** Short plain-token state for Copy diagnostics, e.g. `on:indexeddb` or `off:storage-unavailable`. */
export function recoveryStatus(): string {
  return recoveryEnabled() ? status : 'off:user';
}

export function setRecoveryStatus(next: string): void {
  status = next;
}
