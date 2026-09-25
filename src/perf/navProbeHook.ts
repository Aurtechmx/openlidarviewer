/**
 * The seam between the render loop and the navigation frame probe.
 *
 * The probe itself lives in a lazy chunk (`navProbe.ts`) that loads only under
 * `?benchmark=nav`. The render path imports this module instead: with no sink
 * installed each hook is one property read and a null check, so a normal
 * session pays one branch per hook.
 */

/** Hot sections a long task can be attributed to. */
export type NavSpanName = 'olv:upload' | 'olv:stream' | 'olv:edl' | 'olv:cull';

/** Upload pass fields the probe reads (a structural subset of `UploadProcessResult`). */
export interface NavUploadSample {
  readonly uploaded: number;
  readonly uploadedBytes: number;
  readonly stoppedBy: 'drained' | 'time' | 'bytes' | 'nodes';
}

/** What the render loop reports into. Implemented by `NavProbe`. */
export interface NavProbeSink {
  now(): number;
  /** Clock delta of the frame, in ms, as the viewer's frame recorder accepted it. */
  frameMs(ms: number): void;
  frameBegin(t: number): void;
  upload(sample: NavUploadSample | null | undefined, ms: number): void;
  lodChange(added: number, removed: number): void;
  span(name: NavSpanName, start: number, end: number): void;
  frameEnd(t: number, drawn: boolean, edl: boolean, dpr: number, phase: string): void;
}

/**
 * The global slot the probe installs itself in. A slot rather than a setter
 * import keeps the probe chunk from importing this module, so this module
 * stays inside the Viewer chunk and adds no shared chunk to the startup shell.
 */
export const NAV_SINK_SLOT = '__olvNavSink';

/** The installed sink, or null when no probe is recording. */
export function navSink(): NavProbeSink | null {
  return ((globalThis as Record<string, unknown>)[NAV_SINK_SLOT] as NavProbeSink | undefined) ?? null;
}

/** Feed one accepted frame time to the streaming benchmark and the probe. */
export function feedFrameMs(bench: { recordFrameMs(ms: number): void } | null | undefined, ms: number): void {
  bench?.recordFrameMs(ms);
  navSink()?.frameMs(ms);
}

/**
 * The global slot the `?benchmark=nav` camera driver installs while it plays
 * a trajectory. It receives the camera pose and, in fixed-step mode, hands
 * the render loop the navigation steps to integrate.
 */
export const NAV_DRIVE_SLOT = '__olvNavDrive';

/** What the navigation loop reports into while the camera driver runs. */
export interface NavDriveSink {
  /** Seconds per navigation step in fixed-step mode, or null to integrate the frame clock's delta. */
  readonly fixedDtSec: number | null;
  /** Fixed-step mode: the steps queued since the last call, which the caller now integrates. */
  takeSteps(): number;
  /** The camera pose at the start of a navigation update. */
  pose(position: readonly number[], target: readonly number[], up: readonly number[]): void;
}

/** The installed driver sink, or null when no trajectory is playing. */
export function navDrive(): NavDriveSink | null {
  return ((globalThis as Record<string, unknown>)[NAV_DRIVE_SLOT] as NavDriveSink | undefined) ?? null;
}

/**
 * Integrate navigation for one frame. With no driver, or a driver on the
 * frame clock, `step` runs once with `delta`. In fixed-step mode it runs once
 * per queued step with the fixed dt, and not at all when none is queued, so
 * the camera advances with the driver's step clock rather than with frames.
 */
export function stepNav(delta: number, step: (dt: number) => void): void {
  const drive = navDrive();
  if (drive === null || drive.fixedDtSec === null) {
    step(delta);
    return;
  }
  for (let n = drive.takeSteps(); n > 0; n--) step(drive.fixedDtSec);
}
