/**
 * keyBindingActionLinks.test.ts
 *
 * The key binding table and the action registry must not disagree. A binding
 * that names actions must name existing ones, and each of those actions must
 * advertise the key the binding dispatches; a dispatched binding that names
 * no action must carry its own help line so Help can still list it. The
 * registry is assembled from the contributors over inert fakes. The workflow
 * recorder rows follow its feature flag, so a missing workflow.start is not a
 * failure. Every other id is.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildActionRegistry, type ActionRegistryDeps } from '../src/app/actionDefinitions';
import { shortcutDescriptors } from '../src/ui/keyBindings';
import { CAMERA_PRESET_KEY } from '../src/render/camera/cameraPresets';

const noop = vi.fn();
const actions = buildActionRegistry({
  getViewer: () => ({}) as never, getTour: () => null, workflowController: { capture: noop } as never, lassoVolumeTool: {} as never,
  compass: {} as never, bookmarks: {} as never, showLassoToast: noop, setTheme: noop, syncLassoButton: noop,
  runDeriveClassification: async () => undefined, saveSnapshot: noop, copyShareLink: noop, terrainAnalysisEntry: {} as never,
  runFillUnclassified: async () => undefined, buildCurrentStoryInputs: () => ({}) as never, startWorkflowRecording: noop,
  dispatchWorkflowEvent: noop, ensureWorkflowConfigPanel: async () => ({}) as never, ensureShortcutSheet: async () => ({}) as never,
  hasScan: () => false, saveCurrentView: noop, applyView: noop, toggleOrbitInvert: noop, resetNavigation: noop,
  planView: { togglePlanView: noop, notePlanViewPreset: noop },
} as unknown as ActionRegistryDeps);
const byId = new Map(actions.map((a) => [a.id, a]));
const shortcuts = shortcutDescriptors();

describe('key bindings linked to actions', () => {
  it('every linked action id exists in the registry', () => {
    const missing = shortcuts.flatMap((s) => s.actionIds.filter((id) => !byId.has(id)).map((id) => `${s.id} -> ${id}`));
    // The workflow recorder is absent from the registry when its flag is off.
    expect(missing.filter((m) => !m.endsWith('workflow.start'))).toEqual([]);
  });

  it('a linked action advertises the key its binding dispatches', () => {
    for (const s of shortcuts) {
      if (s.actionIds.length === 0) continue;
      const linked = s.actionIds.map((id) => byId.get(id)).filter((a): a is NonNullable<typeof a> => !!a);
      if (linked.length === 0) continue;
      if (linked.length === 1) {
        expect(linked[0].keys, `${s.id} vs ${linked[0].id}`).toBe(s.displayKeys);
      } else {
        // One binding, several keys: the label joins each action's own key in order.
        expect(linked.map((a) => a.keys).join(' / '), s.id).toBe(s.displayKeys);
      }
    }
  });

  it('the camera preset binding label is the preset key table, in order', () => {
    const camera = shortcuts.find((s) => s.id === 'camera-presets')!;
    expect(camera.displayKeys).toBe(`${CAMERA_PRESET_KEY.top} / ${CAMERA_PRESET_KEY.oblique} / ${CAMERA_PRESET_KEY.planar}`);
  });

  it('a binding that fires no action carries its own help line', () => {
    for (const s of shortcuts) {
      if (s.actionIds.length > 0) continue;
      expect(s.help, s.id).toBeTruthy();
    }
  });

  it('no two registry actions advertise the same bare key unless one binding fires both', () => {
    const linkedTogether = new Set(shortcuts.filter((s) => s.actionIds.length > 1).flatMap((s) => s.actionIds));
    const seen = new Map<string, string>();
    for (const a of actions) {
      if (!a.keys || linkedTogether.has(a.id)) continue;
      expect(seen.has(a.keys), `${a.id} and ${seen.get(a.keys)} both advertise ${a.keys}`).toBe(false);
      seen.set(a.keys, a.id);
    }
  });
});
