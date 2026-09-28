/**
 * Wayfinding journey metrics (spec CE-1, section 11.4). Pure bookkeeping for
 * the journey recorder in `ceJourneys.spec.ts`: it counts clicks, surface
 * switches, Back and Escape presses, and keeps the time to the success signal.
 *
 * Clicks and surface switches are the primary metrics. They depend only on the
 * route the journey takes, so they are the same on every machine. Time depends
 * on the machine and the build, and is kept for information only.
 */

/** Where the user is: the parts of the screen that decide what they see. */
export interface SurfaceState {
  /** Active left-rail mode, or the active phone-sheet tab. */
  mode: string;
  /** Task page title in the active mode, or 'home'. */
  page: string;
  /** Title of an open modal, or ''. */
  modal: string;
  /** Name of an open workspace (Contour Studio, a workbench, a focus view), or ''. */
  workspace: string;
  /** True while the command palette is open. */
  palette: boolean;
}

export type StepKind = 'click' | 'canvas' | 'key' | 'back' | 'escape' | 'type';

export interface JourneyStep {
  kind: StepKind;
  note: string;
  surface: string;
}

export interface JourneyResult {
  id: string;
  viewport: string;
  success: boolean;
  /** Pointer activations, including canvas clicks and Back. */
  clicks: number;
  /** Changes of surface between one step and the next. */
  surfaceSwitches: number;
  backPresses: number;
  escapePresses: number;
  /** Key presses other than Escape (arrows, Enter, shortcuts). */
  keyPresses: number;
  /** Form fields filled in. */
  fieldEntries: number;
  /** Surfaces visited more than once after leaving them. */
  revisits: number;
  /** Informational: wall-clock milliseconds to the success signal. */
  timeToSuccessMs: number | null;
  /** Journey-specific facts (for example, whether a location was readable). */
  facts: Record<string, string | number | boolean | null>;
  path: string[];
}

/** A stable one-line key for a surface state. */
export function surfaceKey(s: SurfaceState): string {
  const parts = [s.mode || '-', s.page || 'home'];
  if (s.workspace) parts.push(`ws:${s.workspace}`);
  if (s.modal) parts.push(`modal:${s.modal}`);
  if (s.palette) parts.push('palette');
  return parts.join(' / ');
}

/** Bookkeeping for one journey run. */
export class JourneyLog {
  private readonly steps: JourneyStep[] = [];
  private readonly visits: string[] = [];
  private readonly t0: number;
  private tSuccess: number | null = null;
  readonly facts: Record<string, string | number | boolean | null> = {};

  readonly id: string;
  readonly viewport: string;

  constructor(id: string, viewport: string, start: SurfaceState, now: number) {
    this.id = id;
    this.viewport = viewport;
    this.t0 = now;
    this.visits.push(surfaceKey(start));
  }

  /** Record one user action and the surface it left the user on. */
  record(kind: StepKind, note: string, after: SurfaceState): void {
    const key = surfaceKey(after);
    this.steps.push({ kind, note, surface: key });
    if (this.visits[this.visits.length - 1] !== key) this.visits.push(key);
  }

  /** Mark the success signal as seen. Only the first call counts. */
  succeed(now: number): void {
    if (this.tSuccess === null) this.tSuccess = now;
  }

  result(): JourneyResult {
    const count = (k: StepKind): number => this.steps.filter((s) => s.kind === k).length;
    const seen = new Set<string>();
    let revisits = 0;
    for (const v of this.visits) {
      if (seen.has(v)) revisits += 1;
      seen.add(v);
    }
    return {
      id: this.id,
      viewport: this.viewport,
      success: this.tSuccess !== null,
      clicks: count('click') + count('canvas') + count('back'),
      surfaceSwitches: this.visits.length - 1,
      backPresses: count('back'),
      escapePresses: count('escape'),
      keyPresses: count('key'),
      fieldEntries: count('type'),
      revisits,
      timeToSuccessMs: this.tSuccess === null ? null : Math.round(this.tSuccess - this.t0),
      facts: { ...this.facts },
      path: [...this.visits],
    };
  }
}
