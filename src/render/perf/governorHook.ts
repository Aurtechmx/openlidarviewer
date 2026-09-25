/**
 * The seam between the render path and the frame budget governor.
 *
 * The governor's wiring (`governorWiring.ts`) is a lazy chunk that loads only
 * under `?governor=on`. The render path calls the functions here instead: with
 * no governor installed each one is a property read and a null check, and the
 * value passed in comes back unchanged.
 *
 * The first call reads the URL once and, when the flag is set, starts the
 * lazy load. Frames before it lands run ungoverned.
 */

import { loadGovernorWiring } from './governorLoader';

/** What the render path asks of an installed governor. Implemented by `GovernorWiring`. */
export interface GovernorSink {
  /** One accepted frame time, in ms, as the viewer's frame recorder took it. */
  frameMs(ms: number): void;
  /** Resolve this frame's policy from the refinement phase, tween state and ms since the camera moved. */
  frame(phase: string, tweening: boolean, quietMs?: number): void;
  /** An output is still reduced, so the loop owes it frames to restore. */
  settling(): boolean;
  /** The backing-store ratio after the policy's pressure; never above `target`. */
  dpr(target: number, floor: number, maxDpr: number): number;
  /** Whether this frame's policy allows Eye Dome Lighting. */
  edl(): boolean;
  /** Apply the drawn point fraction to the point meshes under `root`, building the keep test with `tsl`. */
  points(root: object, tsl: KeepNodeBuilders): void;
  /** The per-frame upload limits after the policy's commit scale. */
  uploadLimits<L extends { readonly maxNodes?: number; readonly maxBytes?: number }>(limits: L, pending: number): L;
}

/**
 * The TSL builders the point keep test is made of. The render path passes the
 * ones it already imports, so the lazy wiring chunk imports no three module
 * and shares no chunk with the Viewer.
 */
export interface KeepNodeBuilders {
  readonly float: (x: unknown) => unknown;
  readonly fract: (x: unknown) => unknown;
  readonly step: (edge: unknown, x: unknown) => unknown;
  readonly uniform: (v: number) => unknown;
  readonly instanceIndex: unknown;
  readonly materialPointSize: unknown;
}

/** The global slot the wiring installs itself in (kept out of this chunk's imports). */
export const GOVERNOR_SLOT = '__olvGovernor';

let urlChecked = false;

function requestFromUrl(): void {
  urlChecked = true;
  if (typeof location === 'undefined') return;
  if (new URLSearchParams(location.search).get('governor') !== 'on') return;
  void loadGovernorWiring().then((m) => m.installGovernor(globalThis));
}

/** The installed governor, or null (the default). */
export function governor(): GovernorSink | null {
  if (!urlChecked) requestFromUrl();
  return ((globalThis as Record<string, unknown>)[GOVERNOR_SLOT] as GovernorSink | undefined) ?? null;
}

/** Whether an installed governor still has a reduced output to restore. */
export function governorSettling(): boolean {
  return governor()?.settling() ?? false;
}

/** The adaptive DPR target after the governor's pressure; `target` itself when none is installed. */
export function governDpr(target: number, floor: number, maxDpr: number): number {
  return governor()?.dpr(target, floor, maxDpr) ?? target;
}

/** Draw the point meshes under `root` at the governor's point fraction; no-op when none is installed. */
export function governPoints(root: object, tsl: KeepNodeBuilders): void {
  governor()?.points(root, tsl);
}
