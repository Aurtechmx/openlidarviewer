/**
 * keyBindings.test.ts
 *
 * Contract + dispatch tests for the declarative keyboard-shortcut table. What
 * these catch:
 *
 *  - A binding losing its id / match / priority / displayKeys, or the table
 *    drifting from the documented precedence.
 *  - The `?` help overlay winning over the `?` sheet — the exact regression the
 *    priority scheme exists to prevent (sheet 400 must beat help 614).
 *  - Measure-mode Backspace / undo-chord routing crossing with the global
 *    Delete / undo: while measuring, the measure binding (110) consumes first;
 *    a chord with nothing drafted falls THROUGH to global undo (600).
 *  - `I` / iso getting wired to a camera preset again (it must stay Inspect-only).
 *  - A bare-key binding firing while a modifier is held.
 *  - `reservedOnly` entries being dispatched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildViewerKeyBindings,
  createKeyDispatcher,
  matchesKey,
  findKeyCollisions,
  type KeyBinding,
  type KeyBindingDeps,
  type GlobalActionHandlers,
} from '../src/ui/keyBindings';

/** A KeyBindingDeps with every method a spy, plus toggles for stateful gates. */
function makeDeps(over: Partial<{
  toolActive: boolean;
  measureMode: boolean;
  drafting: boolean;
  workflowEnabled: boolean;
  workflowMatches: boolean;
  globalActions: GlobalActionHandlers | null;
}> = {}): { deps: KeyBindingDeps; globals: GlobalActionHandlers } {
  const globals: GlobalActionHandlers = {
    onAnnotate: vi.fn(),
    onMeasure: vi.fn(),
    onInspect: vi.fn(),
    onSaveView: vi.fn(),
    onDeleteSelection: vi.fn(),
    onToggleHelp: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  };
  const deps: KeyBindingDeps = {
    isToolActive: () => over.toolActive ?? false,
    setToolPaused: vi.fn(),
    isMeasureMode: () => over.measureMode ?? false,
    isDrafting: () => over.drafting ?? false,
    measureFinish: vi.fn(),
    measureUndoPoint: vi.fn(),
    onEscape: vi.fn(),
    toggleLasso: vi.fn(),
    setCameraPreset: vi.fn(() => true),
    toast: vi.fn(),
    openCommandPalette: vi.fn(),
    toggleShortcutSheet: vi.fn(),
    workflowRecorderEnabled: over.workflowEnabled ?? false,
    matchesWorkflowShortcut: () => over.workflowMatches ?? false,
    toggleWorkflowRecord: vi.fn(),
    globalActions: () =>
      over.globalActions === undefined ? globals : over.globalActions,
  };
  return { deps, globals };
}

interface KeyInit {
  key: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}

/** A plain KeyboardEvent stand-in — the fields the dispatcher reads plus a
 *  preventDefault that flips defaultPrevented (no DOM in the node test env). */
function makeEvent(init: KeyInit): KeyboardEvent {
  const e = {
    key: init.key,
    code: init.code ?? '',
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    target: init.target ?? null,
    defaultPrevented: false,
    preventDefault(): void {
      (this as { defaultPrevented: boolean }).defaultPrevented = true;
    },
  };
  return e as unknown as KeyboardEvent;
}

/** Dispatch one synthetic keydown through a fresh dispatcher. */
function dispatch(
  deps: KeyBindingDeps,
  init: KeyInit,
): { event: KeyboardEvent; prevented: boolean } {
  const handler = createKeyDispatcher(buildViewerKeyBindings(deps), deps);
  const event = makeEvent(init);
  handler(event);
  return { event, prevented: event.defaultPrevented };
}

describe('keyBindings — table contract', () => {
  const table = buildViewerKeyBindings(makeDeps().deps);
  const byId = new Map(table.map((b) => [b.id, b]));

  it('has unique ids and every binding carries a displayKeys label', () => {
    expect(new Set(table.map((b) => b.id)).size).toBe(table.length);
    for (const b of table) expect(b.displayKeys, b.id).toBeTruthy();
  });

  it('encodes the documented precedence order', () => {
    const priority = (id: string): number => byId.get(id)!.priority;
    // sheet MUST beat help; measure MUST beat global delete/undo.
    expect(priority('shortcut-sheet')).toBeLessThan(priority('help-overlay'));
    expect(priority('measure-polygon-keys')).toBeLessThan(priority('delete-selection'));
    expect(priority('measure-polygon-keys')).toBeLessThan(priority('undo-redo-z'));
    // The five formerly-registered listeners, in their old order.
    const order = ['space-reorient', 'lasso-toggle', 'command-palette', 'shortcut-sheet'];
    const ps = order.map(priority);
    expect(ps).toEqual([...ps].sort((a, b) => a - b));
  });

  it('never maps i/I to a camera preset (I/iso stays Inspect-only)', () => {
    const camera = byId.get('camera-presets')!;
    const keys = Array.isArray(camera.match.key) ? camera.match.key : [camera.match.key];
    expect(keys).not.toContain('i');
    expect(keys).not.toContain('I');
    // The only i/I binding is Inspect.
    const iBindings = table.filter((b) => {
      const k = b.match.key;
      const arr = Array.isArray(k) ? k : k === undefined ? [] : [k];
      return arr.includes('i') || arr.includes('I');
    });
    expect(iBindings.map((b) => b.id)).toEqual(['tool-inspect']);
  });

  it('keeps the reserved component-owned keys non-dispatchable', () => {
    const reserved = table.filter((b) => b.reservedOnly).map((b) => b.id);
    expect(reserved).toContain('reserved-nav-controller');
    expect(reserved).toContain('reserved-viewer-escape');
    expect(reserved).toContain('reserved-lasso-draw');
  });
});

describe('matchesKey', () => {
  const k = (init: KeyInit): KeyboardEvent => makeEvent(init);

  it('bareOnly rejects ctrl/meta/alt but allows shift', () => {
    expect(matchesKey({ key: 'a', bareOnly: true }, k({ key: 'a' }))).toBe(true);
    expect(matchesKey({ key: 'a', bareOnly: true }, k({ key: 'a', shiftKey: true }))).toBe(true);
    expect(matchesKey({ key: 'a', bareOnly: true }, k({ key: 'a', ctrlKey: true }))).toBe(false);
    expect(matchesKey({ key: 'a', bareOnly: true }, k({ key: 'a', metaKey: true }))).toBe(false);
    expect(matchesKey({ key: 'a', bareOnly: true }, k({ key: 'a', altKey: true }))).toBe(false);
  });

  it('ctrlOrMeta requires a modifier; shift:false forbids shift', () => {
    expect(matchesKey({ key: 'k', ctrlOrMeta: true }, k({ key: 'k', metaKey: true }))).toBe(true);
    expect(matchesKey({ key: 'k', ctrlOrMeta: true }, k({ key: 'k' }))).toBe(false);
    expect(matchesKey({ key: 't', bareOnly: true, shift: false }, k({ key: 't', shiftKey: true }))).toBe(false);
  });
});

describe('dispatch — one binding runs and consumes per event', () => {
  it('bare a/m/i/v route to the global tool actions', () => {
    for (const [key, method] of [
      ['a', 'onAnnotate'],
      ['m', 'onMeasure'],
      ['i', 'onInspect'],
      ['v', 'onSaveView'],
    ] as const) {
      const { deps, globals } = makeDeps();
      const { prevented } = dispatch(deps, { key });
      expect(globals[method]).toHaveBeenCalledTimes(1);
      expect(prevented).toBe(true);
    }
  });

  it('Delete and Backspace (not measuring) route to onDeleteSelection', () => {
    for (const key of ['Delete', 'Backspace']) {
      const { deps, globals } = makeDeps();
      dispatch(deps, { key });
      expect(globals.onDeleteSelection).toHaveBeenCalledTimes(1);
    }
  });

  it('Ctrl+Z undo, Ctrl+Shift+Z redo, Ctrl+Y redo', () => {
    {
      const { deps, globals } = makeDeps();
      dispatch(deps, { key: 'z', ctrlKey: true });
      expect(globals.onUndo).toHaveBeenCalledTimes(1);
      expect(globals.onRedo).not.toHaveBeenCalled();
    }
    {
      const { deps, globals } = makeDeps();
      dispatch(deps, { key: 'z', ctrlKey: true, shiftKey: true });
      expect(globals.onRedo).toHaveBeenCalledTimes(1);
      expect(globals.onUndo).not.toHaveBeenCalled();
    }
    {
      const { deps, globals } = makeDeps();
      dispatch(deps, { key: 'y', ctrlKey: true });
      expect(globals.onRedo).toHaveBeenCalledTimes(1);
    }
  });

  it('L toggles lasso; T/O/P fire camera presets; Cmd+K opens the palette', () => {
    {
      const { deps } = makeDeps();
      dispatch(deps, { key: 'l' });
      expect(deps.toggleLasso).toHaveBeenCalledTimes(1);
    }
    for (const [key, preset] of [['t', 'top'], ['o', 'oblique'], ['p', 'planar']] as const) {
      const { deps } = makeDeps();
      dispatch(deps, { key });
      expect(deps.setCameraPreset).toHaveBeenCalledWith(preset);
    }
    {
      const { deps } = makeDeps();
      dispatch(deps, { key: 'k', metaKey: true });
      expect(deps.openCommandPalette).toHaveBeenCalledTimes(1);
    }
  });

  it('bare ? runs the SHEET, never the help overlay', () => {
    const { deps, globals } = makeDeps();
    dispatch(deps, { key: '?' });
    expect(deps.toggleShortcutSheet).toHaveBeenCalledTimes(1);
    expect(globals.onToggleHelp).not.toHaveBeenCalled();
  });
});

describe('dispatch — measure-mode precedence', () => {
  it('Backspace while measuring pops a vertex, not the global delete', () => {
    const { deps, globals } = makeDeps({ measureMode: true, drafting: true });
    dispatch(deps, { key: 'Backspace' });
    expect(deps.measureUndoPoint).toHaveBeenCalledTimes(1);
    expect(globals.onDeleteSelection).not.toHaveBeenCalled();
  });

  it('Enter while measuring finishes the current polygon', () => {
    const { deps } = makeDeps({ measureMode: true, drafting: true });
    dispatch(deps, { key: 'Enter' });
    expect(deps.measureFinish).toHaveBeenCalledTimes(1);
  });

  it('the undo chord while measuring-but-not-drafting falls through to global undo', () => {
    const { deps, globals } = makeDeps({ measureMode: true, drafting: false });
    dispatch(deps, { key: 'z', metaKey: true });
    expect(deps.measureUndoPoint).not.toHaveBeenCalled();
    expect(globals.onUndo).toHaveBeenCalledTimes(1);
  });

  it('the undo chord while drafting pops a vertex, not the global undo', () => {
    const { deps, globals } = makeDeps({ measureMode: true, drafting: true });
    dispatch(deps, { key: 'z', metaKey: true });
    expect(deps.measureUndoPoint).toHaveBeenCalledTimes(1);
    expect(globals.onUndo).not.toHaveBeenCalled();
  });
});

describe('dispatch — bare keys ignore held modifiers', () => {
  it('Ctrl+A does not toggle annotate', () => {
    const { deps, globals } = makeDeps();
    dispatch(deps, { key: 'a', ctrlKey: true });
    expect(globals.onAnnotate).not.toHaveBeenCalled();
  });

  it('Shift+T does not fire a camera preset (T/O/P require no shift)', () => {
    const { deps } = makeDeps();
    dispatch(deps, { key: 'T', shiftKey: true });
    expect(deps.setCameraPreset).not.toHaveBeenCalled();
  });
});

describe('dispatch — Space and Escape', () => {
  it('Space pauses the tool only while a tool is active, and consumes', () => {
    {
      const { deps } = makeDeps({ toolActive: true });
      const { prevented } = dispatch(deps, { key: ' ', code: 'Space' });
      expect(deps.setToolPaused).toHaveBeenCalledWith(true);
      expect(prevented).toBe(true);
    }
    {
      const { deps } = makeDeps({ toolActive: false });
      const { prevented } = dispatch(deps, { key: ' ', code: 'Space' });
      expect(deps.setToolPaused).not.toHaveBeenCalled();
      expect(prevented).toBe(false);
    }
  });

  it('Escape runs the exit handler without preventDefault', () => {
    const { deps } = makeDeps();
    const { prevented } = dispatch(deps, { key: 'Escape' });
    expect(deps.onEscape).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(false);
  });
});

describe('dispatch — embed mode (no global handlers wired)', () => {
  it('a/m/i/v/undo/delete are inert when globalActions is null', () => {
    for (const init of [
      { key: 'a' },
      { key: 'm' },
      { key: 'z', ctrlKey: true },
      { key: 'Delete' },
    ]) {
      const { deps } = makeDeps({ globalActions: null });
      const { prevented } = dispatch(deps, init);
      expect(prevented).toBe(false); // fell through, browser default preserved
    }
  });

  it('but the module-top bindings (L, sheet) still work in embed', () => {
    const { deps } = makeDeps({ globalActions: null });
    dispatch(deps, { key: 'l' });
    expect(deps.toggleLasso).toHaveBeenCalledTimes(1);
  });
});

describe('reservedOnly bindings are never dispatched', () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => spy.mockRestore());

  it('an Escape event never triggers a reservedOnly run', () => {
    const { deps } = makeDeps();
    // reserved-viewer-escape / reserved-lasso-draw both match Escape but must
    // be skipped; only escape-exit-tool (dispatchable) runs.
    dispatch(deps, { key: 'Escape', code: 'Escape' });
    expect(deps.onEscape).toHaveBeenCalledTimes(1);
  });
});

describe('findKeyCollisions', () => {
  const noop = () => false;
  const mk = (id: string, match: KeyBinding<unknown>['match'], extra: Partial<KeyBinding<unknown>> = {}): KeyBinding<unknown> =>
    ({ id, match, priority: 0, run: noop, ...extra });

  it('flags two same-signature bindings with non-disjoint context tags', () => {
    const found = findKeyCollisions([
      mk('a', { key: 'x' }, { contextTag: 'global' }),
      mk('b', { key: 'x' }, { contextTag: 'global' }),
    ]);
    expect(found).toHaveLength(1);
    expect([found[0].a, found[0].b].sort()).toEqual(['a', 'b']);
  });

  it('does NOT flag same key in disjoint context tags', () => {
    expect(
      findKeyCollisions([
        mk('a', { key: 'x' }, { contextTag: 'measure' }),
        mk('b', { key: 'x' }, { contextTag: 'camera-nav' }),
      ]),
    ).toHaveLength(0);
  });

  it('treats measure/tool-active as non-disjoint with the global surface', () => {
    // A `global` binding is live while measure mode is on, so they overlap.
    expect(
      findKeyCollisions([
        mk('a', { key: 'x' }, { contextTag: 'measure' }),
        mk('b', { key: 'x' }, { contextTag: 'global' }),
      ]),
    ).toHaveLength(1);
  });

  it('does not overlap distinct case variants of one key', () => {
    // `z` and `Z` are different events (Shift differs), so they never collide.
    expect(
      findKeyCollisions([
        mk('a', { key: 'z' }, { contextTag: 'global' }),
        mk('b', { key: 'Z' }, { contextTag: 'global' }),
      ]),
    ).toHaveLength(0);
  });

  it('rejects overlaps whose modifier constraints can never co-occur', () => {
    // bareOnly forbids Ctrl/Cmd; ctrlOrMeta requires one — no shared event.
    expect(
      findKeyCollisions([
        mk('a', { key: 'x', bareOnly: true }, { contextTag: 'global' }),
        mk('b', { key: 'x', ctrlOrMeta: true }, { contextTag: 'global' }),
      ]),
    ).toHaveLength(0);
  });

  it('treats a reservedOnly binding as an occupied slot against a dispatched one', () => {
    expect(
      findKeyCollisions([
        mk('a', { key: 'x' }, { contextTag: 'global' }),
        mk('b', { key: 'x' }, { contextTag: 'global', reservedOnly: true }),
      ]),
    ).toHaveLength(1);
  });

  it('does not compare two reservedOnly bindings against each other', () => {
    expect(
      findKeyCollisions([
        mk('a', { key: 'x' }, { contextTag: 'global', reservedOnly: true }),
        mk('b', { key: 'x' }, { contextTag: 'global', reservedOnly: true }),
      ]),
    ).toHaveLength(0);
  });
});
