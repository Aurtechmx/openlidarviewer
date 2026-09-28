/**
 * labSurface.ts
 *
 * Where a lab shows its body. The Analyse workspace registers a page host, so
 * Flow Pulse, Terrain Access and Observatory open as Analyse pages beside the
 * scene (spec CE-1, CE-LAB-01). With no page to show (no scan open, so no
 * workspace; or no host registered, as in a unit test) the lab opens in a
 * dialog.
 *
 * The lab component is the same either way: this only decides its parent.
 */
import { openModal, type ModalHandle } from './Modal';
import type { LabId } from '../process/labGuideCopy';

/** What a lab surface gives back: its root and a close that runs `onClose` once. */
export interface LabSurfaceHandle {
  readonly element: HTMLElement;
  close(): void;
}

/** Places a lab body on its page and shows that page; null when no page can show (no scan open). */
export type LabPageHost = (lab: LabId, body: HTMLElement, onClose?: () => void) => LabSurfaceHandle | null;

let host: LabPageHost | null = null;

/** Register (or clear) the page host. */
export function setLabPageHost(h: LabPageHost | null): void { host = h; }

/** Show a lab body on its page, or in a dialog when no page host is registered. */
export function openLabSurface(lab: LabId, title: string, body: HTMLElement, onClose?: () => void): LabSurfaceHandle | ModalHandle {
  const page = host?.(lab, body, onClose);
  if (page) return page;
  const m = openModal({ title, body, onClose });
  m.element?.classList.add('olv-surface-dialog'); // the location bar gives it a named Back
  return m;
}
