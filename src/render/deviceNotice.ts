/**
 * deviceNotice.ts
 *
 * Turns a WebGL context loss or restore into something the user can see. The
 * reporter runs in the Viewer (as the `onChange` of `watchDeviceChanges`): it
 * records the event in the error ledger, asks for a frame after a restore, and
 * raises a bubbling DOM event. The shell binds that event to its status toast
 * with `bindDeviceNotices`, loaded lazily once the Viewer exists. Both notices
 * use the toast's alert styling: each one asks the user to wait or act.
 *
 * A WebGPU device loss is not announced here: it already reaches the toast
 * through the GPU error path with its own wording.
 */
import type { DeviceEvent } from './deviceGeneration';
import { recordError } from '../app/diagnostics/errorLedger';

export const DEVICE_NOTICE_EVENT = 'olv-device-notice';

export const CONTEXT_LOST_NOTICE =
  'Graphics context lost. Your project is unchanged; the view will redraw when the browser restores it.';
/**
 * The restore notice does not promise a redraw. A frame is requested, but the
 * renderer keeps its lost-device state and GPU resources from the old context,
 * so the scene stays blank until the page reloads (measured in chromium: zero
 * draw calls after restoreContext(), even under interaction). Rebuilding the
 * GPU resources is separate work.
 */
export const CONTEXT_RESTORED_NOTICE =
  'Graphics context restored, but the view cannot redraw yet. Your project is unchanged. Save the session, then reload the page to see the scan again.';

export interface DeviceNoticeDetail {
  readonly text: string;
  readonly lost: boolean;
}

/** The toast surface the notice needs (the shell's DropZone satisfies it). */
export interface DeviceNoticeToast {
  setError(text: string): void;
}

export function deviceNoticeReporter(target: EventTarget, requestFrame: () => void): (event: DeviceEvent) => void {
  return (event) => {
    const lost = event === 'webgl-context-lost';
    if (!lost && event !== 'webgl-context-restored') return;
    recordError('gpu', event, true, lost ? 'wait-for-restore' : 'none');
    if (!lost) requestFrame();
    const detail: DeviceNoticeDetail = { text: lost ? CONTEXT_LOST_NOTICE : CONTEXT_RESTORED_NOTICE, lost };
    target.dispatchEvent(new CustomEvent(DEVICE_NOTICE_EVENT, { bubbles: true, detail }));
  };
}

/** Show each device notice on the toast. Returns the detach. */
export function bindDeviceNotices(source: EventTarget, toast: DeviceNoticeToast): () => void {
  const onNotice = (e: Event): void => {
    const detail = (e as CustomEvent<DeviceNoticeDetail>).detail;
    if (detail) toast.setError(detail.text);
  };
  source.addEventListener(DEVICE_NOTICE_EVENT, onNotice);
  return () => source.removeEventListener(DEVICE_NOTICE_EVENT, onNotice);
}
