/**
 * remoteDeepLink.ts
 *
 * The gate in front of a deep-linked remote dataset (`?copc=<url>`). A link
 * someone else wrote must not make this page fetch from a host the user never
 * chose, so the URL goes through the same validator as every other remote
 * entry, and then the user confirms the host before the first request is made.
 * Cancel leaves the app idle: nothing is fetched.
 *
 * Loaded lazily, only when a page URL actually carries a deep link.
 */

import { validateRemoteCopcUrl } from '../io/range/RangeSource';
import { openConfirm } from '../ui/Modal';

export type DeepLinkDecision =
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'invalid'; readonly reason: string };

/** The host a deep link would contact, for the prompt. Never the full URL. */
export function deepLinkHost(url: string): string {
  return new URL(url).host;
}

/**
 * Validate a deep-linked dataset URL and ask the user before anything is
 * fetched. `confirm` is injectable for tests.
 */
export async function confirmDeepLinkedRemote(
  raw: string,
  confirm: typeof openConfirm = openConfirm,
): Promise<DeepLinkDecision> {
  const check = validateRemoteCopcUrl(raw);
  if (!check.ok) return { kind: 'invalid', reason: `This link's dataset URL was refused. ${check.reason}` };
  const host = deepLinkHost(check.url);
  const ok = await confirm({
    title: `Open remote dataset from ${host}?`,
    message:
      `This link asks the viewer to stream a dataset from ${host}. ` +
      'Nothing is requested from that host until you choose Open.',
    confirmLabel: 'Open',
    cancelLabel: 'Cancel',
    confirmTip: `Stream the linked dataset from ${host}.`,
    cancelTip: 'Do not contact that host. The viewer stays empty.',
  });
  return ok ? { kind: 'open', url: check.url } : { kind: 'cancelled' };
}
