/**
 * offlineCopy.ts
 *
 * The opt-in offline copy: "Make available offline" asks the controlling
 * service worker (public/sw.js) to cache every file the build lists in
 * sw-precache.json, and "Remove offline copy" deletes that cache. The choice is
 * kept in local storage for the page; the worker keeps its own record (the
 * offline cache itself) and refills it for a new build when it activates.
 * Loaded on demand from the Help actions, never at startup.
 */
import { storageRemove, storageSet } from '../ui/safeStorage';
import { formatBytesIn } from '../io/formatByteSize';

export const OFFLINE_OPT_IN_KEY = 'olv.offline-copy';
const UNAVAILABLE = 'Offline copies are not available here. The app is not running under its service worker.';

type Notify = (message: string) => void;

export interface OfflineCopyEnv {
  readonly controller: { postMessage(message: unknown, transfer: Transferable[]): void } | null;
  readonly fetchManifest: () => Promise<{ totalBytes?: number } | null>;
}

function defaultEnv(): OfflineCopyEnv {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  return {
    controller: sw?.controller ?? null,
    fetchManifest: () =>
      fetch('./sw-precache.json', { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<{ totalBytes?: number }>) : null))
        .catch(() => null),
  };
}

export function formatMegabytes(bytes: number): string {
  return formatBytesIn(bytes, 'MB');
}

interface SwReply {
  type: 'progress' | 'done' | 'removed' | 'error';
  done?: number;
  total?: number;
  failed?: number;
}

function post(env: OfflineCopyEnv, message: unknown, onReply: (r: SwReply) => boolean): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = (e: MessageEvent<SwReply>) => {
    if (onReply(e.data)) channel.port1.close();
  };
  env.controller!.postMessage(message, [channel.port2]);
}

/** Download every build file into the offline cache; resolves when the worker reports the end. */
export async function makeAvailableOffline(notify: Notify, env: OfflineCopyEnv = defaultEnv()): Promise<boolean> {
  if (!env.controller) {
    notify(UNAVAILABLE);
    return false;
  }
  const manifest = await env.fetchManifest();
  if (!manifest) {
    notify(UNAVAILABLE);
    return false;
  }
  const size = typeof manifest.totalBytes === 'number' ? formatMegabytes(manifest.totalBytes) : 'the app files';
  notify(`Downloading ${size} so the app opens offline.`);
  return new Promise<boolean>((resolve) => {
    let lastQuarter = 0;
    post(env, { type: 'olv-offline-save' }, (r) => {
      if (r.type === 'progress' && r.total) {
        const quarter = Math.floor((4 * (r.done ?? 0)) / r.total);
        if (quarter > lastQuarter && quarter < 4) {
          lastQuarter = quarter;
          notify(`Offline copy ${quarter * 25}% downloaded.`);
        }
        return false;
      }
      if (r.type === 'done' && !r.failed) {
        storageSet(OFFLINE_OPT_IN_KEY, '1');
        notify(`The app is available offline (${size}).`);
        resolve(true);
      } else if (r.type === 'done') {
        storageSet(OFFLINE_OPT_IN_KEY, '1');
        notify(`Offline copy incomplete: ${r.failed} of ${r.total} files failed. Run Make available offline again when online.`);
        resolve(false);
      } else {
        notify('Could not make the app available offline. Check the connection and try again.');
        resolve(false);
      }
      return true;
    });
  });
}

/** Delete the offline cache and forget the choice. */
export async function removeOfflineCopy(notify: Notify, env: OfflineCopyEnv = defaultEnv()): Promise<boolean> {
  storageRemove(OFFLINE_OPT_IN_KEY);
  if (!env.controller) {
    notify(UNAVAILABLE);
    return false;
  }
  return new Promise<boolean>((resolve) => {
    post(env, { type: 'olv-offline-remove' }, (r) => {
      const ok = r.type === 'removed';
      notify(ok ? 'Offline copy removed.' : 'Could not remove the offline copy. Try again.');
      resolve(ok);
      return true;
    });
  });
}
