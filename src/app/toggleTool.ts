import type { WorkflowController } from '../ui/WorkflowController';

/**
 * The mutually-exclusive interaction tools that toggle a Viewer mode and are
 * recorded by the workflow recorder. Probe is deliberately excluded: no path
 * records a probe toggle, so it is not funnelled through here.
 */
export type ToggleableTool = 'measure' | 'inspect' | 'annotate';

/** The slice of the Viewer this helper needs — a getter and a setter per tool. */
export interface ToolToggleViewer {
  readonly measureMode: boolean;
  readonly inspectMode: boolean;
  readonly annotateMode: boolean;
  setMeasureMode(on: boolean): void;
  setInspectMode(on: boolean): void;
  setAnnotateMode(on: boolean): void;
}

const READ: Record<ToggleableTool, (v: ToolToggleViewer) => boolean> = {
  measure: (v) => v.measureMode,
  inspect: (v) => v.inspectMode,
  annotate: (v) => v.annotateMode,
};

const WRITE: Record<ToggleableTool, (v: ToolToggleViewer, on: boolean) => void> = {
  measure: (v, on) => v.setMeasureMode(on),
  inspect: (v, on) => v.setInspectMode(on),
  annotate: (v, on) => v.setAnnotateMode(on),
};

/**
 * Flip one interaction tool and record the toggle, returning the new state.
 *
 * The toolbar, the command palette, and the keyboard each toggled a tool by
 * hand — reading `viewer.<tool>Mode`, calling `set<Tool>Mode`, and (in the
 * palette only) recording the change. The toolbar and keyboard paths omitted
 * that recording, so a workflow captured through the palette differed from one
 * captured through the toolbar for the same action. This centralises the flip
 * and the capture so every path records identically. `capture` is a no-op
 * unless a recording is live, so calling it here is always safe. Callers use
 * the returned next-state for their own extra work (e.g. revealing a
 * workspace) without re-reading the mode.
 */
export function toggleTool(
  viewer: ToolToggleViewer,
  workflow: Pick<WorkflowController, 'capture'>,
  tool: ToggleableTool,
): boolean {
  const next = !READ[tool](viewer);
  WRITE[tool](viewer, next);
  workflow.capture({ type: 'tool', tool, on: next });
  return next;
}

/** Every scene tool a dock button, a key, the palette or the launcher runs. */
export type SceneTool = ToggleableTool | 'clip';

export interface SceneToolDeps {
  viewer: () => ToolToggleViewer;
  workflow: Pick<WorkflowController, 'capture'>;
  /** Flip the clip box through the Clip panel's own write path; the new state. */
  toggleClip: () => boolean;
  /** Reveal the tool's page in the Tools workspace. Presentation only. */
  openPage: (page: Exclude<SceneTool, 'inspect'>) => void;
}

/**
 * The one command behind every entry point for a scene tool. The dock, the
 * keyboard, the command palette and the Tools launcher used to diverge: the
 * dock toggled the tool and switched to Tools, the others only toggled it.
 * Each now runs the registry action, whose body is this: flip the tool, record
 * it, and when it turned on, open its page. Inspect has no panel, so it only
 * toggles.
 */
export function runSceneTool(deps: SceneToolDeps, tool: SceneTool): boolean {
  const on = tool === 'clip' ? deps.toggleClip() : toggleTool(deps.viewer(), deps.workflow, tool);
  if (on && tool !== 'inspect') deps.openPage(tool);
  return on;
}
