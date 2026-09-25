/**
 * deviceNotice.ts
 *
 * Turns a WebGL context loss or restore into something the user can see. The
 * reporter runs in the Viewer (as the `onChange` of `watchDeviceChanges`): it
 * records the event in the error ledger, starts the recovery after a restore
 * (`contextRecovery.ts` rebuilds the renderer and redraws), and raises a
 * bubbling DOM event with the outcome. The shell binds that event to its status
 * toast with `bindDeviceNotices`, loaded lazily once the Viewer exists.
 *
 * A WebGPU device loss is not announced here: it already reaches the toast
 * through the GPU error path with its own wording.
 */
import type { DeviceEvent } from './deviceGeneration';
import { recordError } from '../app/diagnostics/errorLedger';

export const DEVICE_NOTICE_EVENT = 'olv-device-notice';

export const CONTEXT_LOST_NOTICE =
  'Graphics context lost. Your project is unchanged. The view redraws when the browser restores the context; if it does not, save the session and reload the page.';
/** The restore notice once the rebuilt renderer is drawing. */
export const CONTEXT_RESTORED_NOTICE = 'Graphics context restored; the view has been redrawn.';
/** The restore notice when the rebuild failed and the view stays blank. */
export const CONTEXT_RECOVERY_FAILED_NOTICE =
  'Graphics context restored, but the view could not be redrawn. Your project is unchanged. Save the session, then reload the page to see the scan again.';

export interface DeviceNoticeDetail {
  readonly text: string;
  readonly lost: boolean;
}

/** The toast surface the notice needs (the shell's DropZone satisfies it). */
export interface DeviceNoticeToast {
  setError(text: string): void;
}

export function deviceNoticeReporter(target: EventTarget, recover: () => Promise<boolean>): (event: DeviceEvent) => void {
  const notify = (text: string, lost: boolean): void => {
    const detail: DeviceNoticeDetail = { text, lost };
    target.dispatchEvent(new CustomEvent(DEVICE_NOTICE_EVENT, { bubbles: true, detail }));
  };
  return (event) => {
    const lost = event === 'webgl-context-lost';
    if (!lost && event !== 'webgl-context-restored') return;
    recordError('gpu', event, true, lost ? 'wait-for-restore' : 'none');
    if (lost) return notify(CONTEXT_LOST_NOTICE, true);
    void recover().then(
      (ok) => notify(ok ? CONTEXT_RESTORED_NOTICE : CONTEXT_RECOVERY_FAILED_NOTICE, !ok),
      () => notify(CONTEXT_RECOVERY_FAILED_NOTICE, true),
    );
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
