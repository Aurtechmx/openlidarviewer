/**
 * keyBindings.ts
 *
 * ONE declarative table for the app's global keyboard shortcuts, plus the single
 * `window` keydown dispatcher that runs it. Before this module the shortcuts
 * lived in five separate `window.addEventListener('keydown', …)` blocks in
 * main.ts and one more in shortcuts.ts (`bindShortcuts`), so which handler won a
 * shared key was decided by *registration order* — a fragile, invisible
 * contract (the `?` sheet only beat the `?` help overlay because it happened to
 * register earlier and call `preventDefault`). Here precedence is DATA: every
 * binding carries an explicit `priority`, the dispatcher runs them in ascending
 * priority, and the first that consumes the event wins. Lower priority fires
 * earlier, so it reproduces the old registration order exactly.
 *
 * The dispatcher owns only ROUTING. The actual behaviour (measure undo/redo,
 * tool toggles, camera presets, …) stays in the existing viewer methods and
 * handlers, reached through the injected `KeyBindingDeps` — nothing is
 * reimplemented here.
 *
 * Component listeners that need keyup / held-state / e.repeat (NavController's
 * WASD+arrows, Viewer's tool-mode Escape, LassoVolumeTool's draw-abort) are NOT
 * migrated; they stay where they are. They appear here only as `reservedOnly`
 * entries so a future collision lint knows those keys are taken. `reservedOnly`
 * entries are NEVER dispatched.
 *
 * Browser-bound only in `installKeyDispatch`; the table + helpers are pure.
 */

import { isEditableTarget, isTypingTarget, measureKeyAction } from './shortcuts';
import { CAMERA_PRESET_KEY } from '../render/camera/cameraPresets';

/** A key-event shape a `KeyMatch` is tested against. */
type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'
>;

/**
 * A structural key predicate. Every listed field must hold for a match.
 *
 * - `key` / `code` — one value or an alternation. `key` is matched EXACTLY
 *   (case-sensitive), so an entry that must survive Caps Lock / Shift lists both
 *   cases (`['z', 'Z']`), exactly as the hand-written handlers did.
 * - `ctrlOrMeta` — `true` requires Ctrl or Cmd; `false` requires neither.
 * - `bareOnly` — reject if Ctrl / Cmd / Alt is held. Shift is still allowed
 *   (this is the `if (e.ctrlKey || e.metaKey || e.altKey) return;` guard the old
 *   bare-key handler used, so Shift+/ = `?` and Shift+A = `A` still pass).
 * - `shift` / `alt` — `true` requires the modifier, `false` forbids it,
 *   `'any'` / omitted leaves it unconstrained.
 */
export interface KeyMatch {
  key?: string | string[];
  code?: string;
  ctrlOrMeta?: boolean;
  shift?: boolean | 'any';
  alt?: boolean;
  bareOnly?: boolean;
}

/** Per-event focus state the dispatcher computes ONCE and hands every binding. */
export interface KeyDispatchState {
  /** `isTypingTarget()` — activeElement-based; the guard `bindShortcuts` used. */
  isTyping: boolean;
  /** `isEditableTarget(e.target)` — ancestor-walk; the guard main.ts:753 used. */
  isEditable: boolean;
}

/** The context passed to `when` / `run`: injected deps plus the per-event state. */
export type KeyContext<Deps> = Deps & KeyDispatchState;

/** One declarative shortcut. */
export interface KeyBinding<Deps> {
  /** Stable id (used by the collision lint and by tests). */
  id: string;
  /** Structural key predicate. */
  match: KeyMatch;
  /** Extra gate beyond `match` (mode/focus). Omitted = always eligible. */
  when?: (ctx: KeyContext<Deps>, e: KeyboardEvent) => boolean;
  /** Ascending precedence: lower runs first. */
  priority: number;
  /** Perform the action. Return `true` when the event is consumed. */
  run: (ctx: KeyContext<Deps>, e: KeyboardEvent) => boolean;
  /** Call `preventDefault()` when consumed. Defaults to `true`. */
  preventDefault?: boolean;
  /** Human-readable key label for help surfaces. */
  displayKeys?: string;
  /** Scope tag for the collision lint; two same-signature bindings whose tags
   *  are non-disjoint are a collision. */
  contextTag?: string;
  /** Documented-but-not-dispatched: a key owned by a component listener. */
  reservedOnly?: boolean;
}

/** Test a `KeyMatch` against an event. */
export function matchesKey(m: KeyMatch, e: KeyEventLike): boolean {
  if (m.code !== undefined && e.code !== m.code) return false;
  if (m.key !== undefined) {
    const keys = Array.isArray(m.key) ? m.key : [m.key];
    if (!keys.includes(e.key)) return false;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (m.ctrlOrMeta === true && !mod) return false;
  if (m.ctrlOrMeta === false && mod) return false;
  if (m.bareOnly && (e.ctrlKey || e.metaKey || e.altKey)) return false;
  if (m.shift === true && !e.shiftKey) return false;
  if (m.shift === false && e.shiftKey) return false;
  if (m.alt === true && !e.altKey) return false;
  if (m.alt === false && e.altKey) return false;
  return true;
}

/**
 * Install the ONE non-capture `window` keydown dispatcher.
 *
 * Per event it: (1) bails if another listener already consumed the key
 * (`e.defaultPrevented`); (2) computes typing/editable focus state once;
 * (3) walks the bindings in ascending `priority`, skipping `reservedOnly`
 * ones, and runs the first whose `match` + `when` pass. If `run` returns
 * `true` the walk stops (the event is consumed) and, unless
 * `preventDefault === false`, `e.preventDefault()` is called. A `run` that
 * returns `false` leaves the event live for the next binding — this is what
 * lets a mid-measurement chord fall through to the global undo, exactly as the
 * separate listeners did via `defaultPrevented`.
 *
 * Returns a disposer.
 */
export function installKeyDispatch<Deps>(
  bindings: ReadonlyArray<KeyBinding<Deps>>,
  deps: Deps,
): () => void {
  const onKeyDown = createKeyDispatcher(bindings, deps);
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}

/**
 * Build the keydown handler `installKeyDispatch` attaches — split out so the
 * routing can be unit-tested without a DOM. It implements the whole precedence
 * contract; `installKeyDispatch` only owns the `window` listener lifecycle.
 */
export function createKeyDispatcher<Deps>(
  bindings: ReadonlyArray<KeyBinding<Deps>>,
  deps: Deps,
): (e: KeyboardEvent) => void {
  const ordered = bindings
    .filter((b) => !b.reservedOnly)
    .slice()
    .sort((a, b) => a.priority - b.priority);

  return (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    const state: KeyDispatchState = {
      isTyping: isTypingTarget(),
      isEditable: isEditableTarget(e.target),
    };
    const ctx = { ...(deps as object), ...state } as KeyContext<Deps>;
    for (const b of ordered) {
      if (!matchesKey(b.match, e)) continue;
      if (b.when && !b.when(ctx, e)) continue;
      const consumed = b.run(ctx, e);
      if (consumed) {
        if (b.preventDefault !== false) e.preventDefault();
        return;
      }
    }
  };
}

/** A canonical, order-independent signature for a `KeyMatch`. */
function keySignature(m: KeyMatch): string {
  let keys: string[];
  if (m.key === undefined) keys = [];
  else if (Array.isArray(m.key)) keys = [...m.key];
  else keys = [m.key];
  keys.sort((a, b) => a.localeCompare(b));
  return JSON.stringify({
    key: keys,
    code: m.code ?? null,
    ctrlOrMeta: m.ctrlOrMeta ?? null,
    shift: m.shift ?? null,
    alt: m.alt ?? null,
    bareOnly: m.bareOnly ?? false,
  });
}

/** A reported collision: two bindings that could fire on one key event. */
export interface KeyCollision {
  a: string;
  b: string;
  signature: string;
  contextTag?: string;
}

/** The individual `key` tokens a match can fire on (empty for a code-only or
 *  externally-matched entry). */
function matchKeys(m: KeyMatch): string[] {
  if (m.key === undefined) return [];
  return Array.isArray(m.key) ? m.key : [m.key];
}

/**
 * Whether two matches can be satisfied by the SAME key event: they must share
 * a concrete key token (or the same `code`) AND their modifier constraints must
 * be jointly satisfiable. Case variants are distinct tokens on purpose — `z`
 * and `Z` are different events (Shift differs), so a `['z']` binding and a
 * `['Z']` binding do not overlap, while the table's `['z','Z']` entries do.
 */
function slotsOverlap(a: KeyMatch, b: KeyMatch): boolean {
  const aKeys = new Set(matchKeys(a));
  const shareKey = matchKeys(b).some((k) => aKeys.has(k));
  const shareCode = a.code !== undefined && b.code !== undefined && a.code === b.code;
  if (!shareKey && !shareCode) return false;
  return modsCompatible(a, b);
}

/** Reject only modifier pairs that can never co-occur on one event. */
function modsCompatible(a: KeyMatch, b: KeyMatch): boolean {
  if (a.ctrlOrMeta === true && b.ctrlOrMeta === false) return false;
  if (a.ctrlOrMeta === false && b.ctrlOrMeta === true) return false;
  // `bareOnly` forbids Ctrl / Cmd / Alt, so it cannot meet a peer that requires one.
  if (a.bareOnly && (b.ctrlOrMeta === true || b.alt === true)) return false;
  if (b.bareOnly && (a.ctrlOrMeta === true || a.alt === true)) return false;
  if (a.shift === true && b.shift === false) return false;
  if (a.shift === false && b.shift === true) return false;
  if (a.alt === true && b.alt === false) return false;
  if (a.alt === false && b.alt === true) return false;
  return true;
}

/**
 * Context tags that layer onto the ONE global keydown surface this dispatcher
 * owns: a `global` binding stays live while `tool-active` / `measure` mode is
 * on, so those scopes are NON-disjoint with `global` (and with each other).
 * Every other tag names a separate component listener's surface
 * (`camera-nav`, `tool-mode`, `lasso-draw`), which is disjoint from these — an
 * event handled there is not handled here.
 */
const DISPATCH_SURFACE_TAGS = new Set(['global', 'tool-active', 'measure']);

/** Two context scopes are disjoint when they can never both own an event. */
function tagsDisjoint(a?: string, b?: string): boolean {
  if (a === undefined || b === undefined) return false; // untagged = any scope
  if (a === b) return false;
  if (DISPATCH_SURFACE_TAGS.has(a) && DISPATCH_SURFACE_TAGS.has(b)) return false;
  return true;
}

/**
 * Flag pairs of bindings that could fire on the same key event in a
 * non-disjoint context. `reservedOnly` entries are OCCUPIED SLOTS: a dispatched
 * binding that lands on a reserved (component-owned) key in a shared scope is
 * flagged, even though reserved entries are never dispatched. Two reserved
 * entries are not compared against each other (neither runs here). Pure — the
 * collision-lint test consumes this.
 */
export function findKeyCollisions<Deps>(
  bindings: ReadonlyArray<KeyBinding<Deps>>,
): KeyCollision[] {
  const collisions: KeyCollision[] = [];
  for (let i = 0; i < bindings.length; i++) {
    for (let j = i + 1; j < bindings.length; j++) {
      const a = bindings[i];
      const b = bindings[j];
      if (a.reservedOnly && b.reservedOnly) continue;
      if (!slotsOverlap(a.match, b.match)) continue;
      if (tagsDisjoint(a.contextTag, b.contextTag)) continue;
      collisions.push({
        a: a.id,
        b: b.id,
        signature: keySignature(a.match),
        contextTag: a.contextTag ?? b.contextTag,
      });
    }
  }
  return collisions;
}

/** The full app's global-action handlers (was `ShortcutHandlers`). Supplied
 *  lazily: `null` until the full (non-embed) app wires them after the viewer
 *  loads, so in embed mode these keys stay unbound exactly as before. */
export interface GlobalActionHandlers {
  onAnnotate: () => void;
  onMeasure: () => void;
  onInspect: () => void;
  onSaveView: () => void;
  onDeleteSelection: () => void;
  onToggleHelp: () => void;
  onUndo: () => void;
  onRedo: () => void;
}

/** Everything the table's `run` bodies reach into. Injected so the table stays
 *  decoupled from main.ts and unit-testable with spies. */
export interface KeyBindingDeps {
  // Space re-orient (priority 100)
  isToolActive: () => boolean;
  setToolPaused: (paused: boolean) => void;
  // Measure polygon keys (110)
  isMeasureMode: () => boolean;
  isDrafting: () => boolean;
  measureFinish: () => void;
  measureUndoPoint: () => void;
  // Universal Escape (120)
  onEscape: () => void;
  // Lasso toggle — L (200)
  toggleLasso: () => void;
  // Camera presets — T / O / P (210)
  setCameraPreset: (preset: 'top' | 'oblique' | 'planar') => boolean | undefined;
  toast: (message: string) => void;
  // Command palette — Cmd/Ctrl+K (300)
  openCommandPalette: () => void;
  // Shortcut sheet — ? (400)
  toggleShortcutSheet: () => void;
  // Workflow recorder chord (500) — inert unless the flag is on
  workflowRecorderEnabled: boolean;
  matchesWorkflowShortcut: (e: KeyboardEvent) => boolean;
  toggleWorkflowRecord: () => void;
  // Global actions (600+) — null until the full app wires them
  globalActions: () => GlobalActionHandlers | null;
}

/** The inline focus guard main.ts:872 / :901 / :1860 used: the event target
 *  itself is an INPUT/TEXTAREA, or is (inside) a contenteditable. Kept distinct
 *  from `isEditable` / `isTyping` because the task requires the exact original
 *  guard at each site (no unification). */
function targetIsField(e: KeyboardEvent): boolean {
  const t = e.target as (HTMLElement & { isContentEditable?: boolean }) | null;
  const tag = t?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable === true;
}

/**
 * Build the declarative binding table. Priorities encode the exact pre-refactor
 * precedence: 100/110/120 = the main.ts:753 Space/measure/Escape listener;
 * 200/210 = the main.ts:872 L / T-O-P listener; 300 = Cmd+K; 400 = the `?`
 * sheet (MUST beat the 614 `?` help overlay — reproduced by 400 < 614);
 * 500 = the flag-gated workflow chord; 600+ = the former `bindShortcuts`.
 */
export function buildViewerKeyBindings(
  deps: KeyBindingDeps,
): KeyBinding<KeyBindingDeps>[] {
  const bindings: KeyBinding<KeyBindingDeps>[] = [
    // ── main.ts:753 group (isEditableTarget guard on all three) ──────────
    {
      id: 'space-reorient',
      match: { code: 'Space' },
      priority: 100,
      contextTag: 'tool-active',
      displayKeys: 'Space (hold)',
      when: (ctx) => !ctx.isEditable && ctx.isToolActive(),
      run: (_ctx, e) => {
        // Always consumes while a tool is active — even on auto-repeat — so the
        // page never scrolls; only the leading press pauses the tool.
        if (!e.repeat) deps.setToolPaused(true);
        return true;
      },
    },
    {
      id: 'measure-polygon-keys',
      match: { key: ['Enter', 'Backspace', 'z', 'Z'] },
      priority: 110,
      contextTag: 'measure',
      displayKeys: 'Enter / Backspace / ⌘Z',
      when: (ctx) => !ctx.isEditable && ctx.isMeasureMode(),
      run: (_ctx, e) => {
        const action = measureKeyAction(e, deps.isDrafting());
        if (!action) return false; // chord with nothing drafted falls through
        if (action === 'finish') deps.measureFinish();
        else deps.measureUndoPoint();
        return true;
      },
    },
    {
      id: 'escape-exit-tool',
      match: { key: 'Escape' },
      priority: 120,
      contextTag: 'global',
      displayKeys: 'Esc',
      // The original handler never called preventDefault on Escape.
      preventDefault: false,
      when: (ctx) => !ctx.isEditable,
      run: () => {
        deps.onEscape();
        return true;
      },
    },
    // ── main.ts:872 group (targetIsField guard) ──────────────────────────
    {
      id: 'lasso-toggle',
      match: { key: ['l', 'L'] },
      priority: 200,
      contextTag: 'global',
      displayKeys: 'L',
      // The original L branch did NOT call preventDefault.
      preventDefault: false,
      when: (_ctx, e) => !targetIsField(e),
      run: () => {
        deps.toggleLasso();
        return true;
      },
    },
    {
      id: 'camera-presets',
      match: { key: ['t', 'T', 'o', 'O', 'p', 'P'], bareOnly: true, shift: false },
      priority: 210,
      contextTag: 'global',
      // Derived from cameraPresets so the chip cannot drift from the keys the
      // presets actually advertise (single source: CAMERA_PRESET_KEY).
      displayKeys: `${CAMERA_PRESET_KEY.top} / ${CAMERA_PRESET_KEY.oblique} / ${CAMERA_PRESET_KEY.planar}`,
      when: (_ctx, e) => !targetIsField(e),
      run: (_ctx, e) => {
        const k = e.key.toLowerCase();
        let preset: 'top' | 'oblique' | 'planar' = 'planar';
        if (k === 't') preset = 'top';
        else if (k === 'o') preset = 'oblique';
        const fired = deps.setCameraPreset(preset);
        if (fired) {
          deps.toast(`Camera · ${preset[0].toUpperCase()}${preset.slice(1)} view.`);
        }
        return true; // always consumed (original preventDefault'd regardless)
      },
    },
    // ── main.ts:1849 — command palette ───────────────────────────────────
    {
      id: 'command-palette',
      match: { key: ['k', 'K'], ctrlOrMeta: true },
      priority: 300,
      contextTag: 'global',
      displayKeys: '⌘K / Ctrl+K',
      run: () => {
        deps.openCommandPalette();
        return true;
      },
    },
    // ── main.ts:1860 — shortcut sheet (MUST beat the 614 help overlay) ────
    {
      id: 'shortcut-sheet',
      match: { key: '?', bareOnly: true },
      priority: 400,
      contextTag: 'global',
      displayKeys: '?',
      when: (_ctx, e) => !targetIsField(e),
      run: () => {
        deps.toggleShortcutSheet();
        return true;
      },
    },
    // ── main.ts:1898 — workflow recorder chord (flag-gated, inert today) ──
    {
      id: 'workflow-recorder',
      match: {}, // matcher lives in matchesWorkflowShortcut (config-driven)
      priority: 500,
      contextTag: 'global',
      // The exact chip the workflow-start action advertised before this became
      // the single source; kept verbatim so the registry chip is unchanged.
      displayKeys: 'Cmd-Shift-U',
      when: (_ctx, e) => {
        if (!deps.workflowRecorderEnabled) return false;
        const active = typeof document === 'undefined' ? null : document.activeElement;
        if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return false;
        return deps.matchesWorkflowShortcut(e);
      },
      run: () => {
        deps.toggleWorkflowRecord();
        return true;
      },
    },
    // ── shortcuts.ts bindShortcuts — attached LAST today (isTyping guard) ─
    {
      id: 'undo-redo-z',
      match: { key: ['z', 'Z'], ctrlOrMeta: true },
      priority: 600,
      contextTag: 'global',
      displayKeys: '⌘Z / ⌘⇧Z',
      when: (ctx) => !ctx.isTyping,
      run: (_ctx, e) => {
        const h = deps.globalActions();
        if (!h) return false;
        if (e.shiftKey) h.onRedo();
        else h.onUndo();
        return true;
      },
    },
    {
      id: 'redo-y',
      match: { key: ['y', 'Y'], ctrlOrMeta: true },
      priority: 601,
      contextTag: 'global',
      displayKeys: '⌘Y / Ctrl+Y',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onRedo();
        return true;
      },
    },
    {
      id: 'tool-annotate',
      match: { key: ['a', 'A'], bareOnly: true },
      priority: 610,
      contextTag: 'global',
      displayKeys: 'A',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onAnnotate();
        return true;
      },
    },
    {
      id: 'tool-measure',
      match: { key: ['m', 'M'], bareOnly: true },
      priority: 611,
      contextTag: 'global',
      displayKeys: 'M',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onMeasure();
        return true;
      },
    },
    {
      id: 'tool-inspect',
      match: { key: ['i', 'I'], bareOnly: true },
      priority: 612,
      contextTag: 'global',
      displayKeys: 'I',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onInspect();
        return true;
      },
    },
    {
      id: 'save-view',
      match: { key: ['v', 'V'], bareOnly: true },
      priority: 613,
      contextTag: 'global',
      displayKeys: 'V',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onSaveView();
        return true;
      },
    },
    {
      id: 'help-overlay',
      match: { key: '?', bareOnly: true },
      priority: 614,
      contextTag: 'global',
      displayKeys: '?',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onToggleHelp();
        return true;
      },
    },
    {
      id: 'delete-selection',
      match: { key: ['Delete', 'Backspace'], bareOnly: true },
      priority: 615,
      contextTag: 'global',
      displayKeys: 'Delete / Backspace',
      when: (ctx) => !ctx.isTyping,
      run: () => {
        const h = deps.globalActions();
        if (!h) return false;
        h.onDeleteSelection();
        return true;
      },
    },
    // ── reservedOnly: keys owned by component listeners (NEVER dispatched).
    //    Present so a future collision lint knows they are taken. ──────────
    {
      id: 'reserved-nav-controller',
      // Real `key` values (not `e.code` strings), so the collision lint reads
      // them as occupied slots and can catch a dispatched binding placed on a
      // nav key in a shared scope. Both cases are listed because the lint
      // treats `w` and `W` as distinct events.
      match: {
        key: [
          '1', '2', '3', '4',
          'r', 'R', 'f', 'F', 'h', 'H', 'g', 'G',
          'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
          'w', 'W', 'a', 'A', 's', 'S', 'd', 'D', 'c', 'C',
        ],
      },
      priority: 10_000,
      contextTag: 'camera-nav',
      displayKeys: '1–4 / R F H G / WASD / Arrows',
      reservedOnly: true,
      when: () => false,
      run: () => false,
    },
    {
      id: 'reserved-viewer-escape',
      match: { code: 'Escape' },
      priority: 10_001,
      contextTag: 'tool-mode',
      displayKeys: 'Esc',
      reservedOnly: true,
      when: () => false,
      run: () => false,
    },
    {
      id: 'reserved-lasso-draw',
      match: { key: 'Escape' },
      priority: 10_002,
      contextTag: 'lasso-draw',
      displayKeys: 'Esc',
      reservedOnly: true,
      when: () => false,
      run: () => false,
    },
  ];
  return bindings;
}

/**
 * No-op deps used only to instantiate the table for its STATIC metadata (ids,
 * `displayKeys`). `run` / `when` are never invoked here, so the stubs never
 * fire — this reads the shape of the table, not its behaviour.
 */
const DISPLAY_META_DEPS: KeyBindingDeps = {
  isToolActive: () => false,
  setToolPaused: () => {},
  isMeasureMode: () => false,
  isDrafting: () => false,
  measureFinish: () => {},
  measureUndoPoint: () => {},
  onEscape: () => {},
  toggleLasso: () => {},
  setCameraPreset: () => undefined,
  toast: () => {},
  openCommandPalette: () => {},
  toggleShortcutSheet: () => {},
  workflowRecorderEnabled: false,
  matchesWorkflowShortcut: () => false,
  toggleWorkflowRecord: () => {},
  globalActions: () => null,
};

/** id → `displayKeys`, built ONCE from the table so display surfaces (the
 *  command-palette / shortcut-sheet registry) can derive their key chips from
 *  the same source that dispatches the keys. */
const KEY_DISPLAY_BY_ID: ReadonlyMap<string, string> = new Map(
  buildViewerKeyBindings(DISPLAY_META_DEPS)
    .filter((b) => b.displayKeys !== undefined)
    .map((b) => [b.id, b.displayKeys as string]),
);

/** The help chip a binding advertises, or `undefined` for an unknown id. */
export function keyDisplayFor(id: string): string | undefined {
  return KEY_DISPLAY_BY_ID.get(id);
}
