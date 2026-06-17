/**
 * workflowConfig.ts
 *
 * The user-tunable settings for the workflow recorder, plus the small pure
 * helpers the settings panel and the global key handler share: parsing a
 * persisted config, and matching / formatting / capturing a keyboard chord.
 *
 * Pure — no DOM, no three.js — unit-tested in Node. The chord helpers take a
 * minimal `{ key, metaKey, ctrlKey, altKey, shiftKey }` so they can be tested
 * without a real KeyboardEvent.
 */

/** How a saved `.olvworkflow` is serialised. */
export type WorkflowFormat = 'readable' | 'compact';

/** Where a saved workflow goes. */
export type WorkflowSaveMode = 'picker' | 'download';

/** Which families of action are recorded. */
export interface WorkflowCaptureScope {
  readonly camera: boolean;
  readonly theme: boolean;
  readonly tools: boolean;
}

/** Every workflow-recorder preference. */
export interface WorkflowRecorderConfig {
  /** Pretty (readable) or minified JSON in the saved file. */
  readonly format: WorkflowFormat;
  /** Native save-as picker (choose name + folder) or a plain download. */
  readonly saveMode: WorkflowSaveMode;
  /** Start/stop chord, normalised (e.g. `mod+shift+u`). Empty string = no key. */
  readonly shortcut: string;
  /** Replay rate: 0.5 / 1 / 2, or 0 for instant (no inter-event delay). */
  readonly replaySpeed: number;
  /** Seconds to count down before recording actually starts (0 = none). */
  readonly countdownSeconds: number;
  /** Replay on a loop until stopped. */
  readonly loop: boolean;
  /** Which action families are captured. */
  readonly capture: WorkflowCaptureScope;
}

/** The shipped defaults — `mod+shift+u`, readable, 1× replay, capture all. */
export const DEFAULT_WORKFLOW_CONFIG: WorkflowRecorderConfig = {
  format: 'readable',
  saveMode: 'download',
  shortcut: 'mod+shift+u',
  replaySpeed: 1,
  countdownSeconds: 0,
  loop: false,
  capture: { camera: true, theme: true, tools: true },
};

/** The replay speeds the panel offers (0 = instant). */
export const WORKFLOW_REPLAY_SPEEDS: readonly number[] = [0.5, 1, 2, 0];

/** A modifier key name that can never be the "key" half of a chord. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Meta', 'Alt', 'CapsLock']);

/** The minimal keyboard-event shape the chord helpers need. */
export interface ChordEventLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/** Lower-case a single-character key; pass named keys (e.g. "F2") through. */
function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Build a normalised chord string from a key event, or `null` when it is not a
 * usable shortcut. A recorder chord MUST carry Cmd/Ctrl or Alt — a bare or
 * shift-only key would collide with the single-key tool shortcuts.
 */
export function chordFromEvent(e: ChordEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  const mod = e.metaKey || e.ctrlKey;
  if (!mod && !e.altKey) return null;
  const parts: string[] = [];
  if (mod) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(normaliseKey(e.key));
  return parts.join('+');
}

/** Whether a key event matches a normalised chord. Empty chord never matches. */
export function matchesShortcut(e: ChordEventLike, chord: string): boolean {
  if (chord === '') return false;
  const tokens = chord.split('+');
  const key = tokens[tokens.length - 1];
  const wantMod = tokens.includes('mod');
  const wantAlt = tokens.includes('alt');
  const wantShift = tokens.includes('shift');
  return (
    (e.metaKey || e.ctrlKey) === wantMod &&
    e.altKey === wantAlt &&
    e.shiftKey === wantShift &&
    normaliseKey(e.key) === key
  );
}

/** Human label for a chord, e.g. `⌘⇧U` on mac, `Ctrl+Shift+U` elsewhere. */
export function formatShortcutLabel(chord: string, isMac: boolean): string {
  if (chord === '') return 'Off';
  const tokens = chord.split('+');
  const key = tokens[tokens.length - 1];
  const keyLabel = key.length === 1 ? key.toUpperCase() : key;
  if (isMac) {
    let s = '';
    if (tokens.includes('mod')) s += '⌘';
    if (tokens.includes('alt')) s += '⌥';
    if (tokens.includes('shift')) s += '⇧';
    return s + keyLabel;
  }
  const parts: string[] = [];
  if (tokens.includes('mod')) parts.push('Ctrl');
  if (tokens.includes('alt')) parts.push('Alt');
  if (tokens.includes('shift')) parts.push('Shift');
  parts.push(keyLabel);
  return parts.join('+');
}

/** Pick the bool, falling back to a default. */
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Validate a raw persisted value into a complete {@link WorkflowRecorderConfig},
 * falling back to the default for any missing or malformed field. Never throws.
 */
export function parseWorkflowConfig(raw: unknown): WorkflowRecorderConfig {
  const d = DEFAULT_WORKFLOW_CONFIG;
  if (!raw || typeof raw !== 'object') return d;
  const o = raw as Record<string, unknown>;
  const cap = (o.capture && typeof o.capture === 'object' ? o.capture : {}) as Record<string, unknown>;
  return {
    format: o.format === 'compact' ? 'compact' : 'readable',
    saveMode: o.saveMode === 'picker' ? 'picker' : 'download',
    shortcut: typeof o.shortcut === 'string' ? o.shortcut : d.shortcut,
    replaySpeed: WORKFLOW_REPLAY_SPEEDS.includes(o.replaySpeed as number)
      ? (o.replaySpeed as number)
      : d.replaySpeed,
    countdownSeconds: o.countdownSeconds === 3 ? 3 : 0,
    loop: boolOr(o.loop, d.loop),
    capture: {
      camera: boolOr(cap.camera, d.capture.camera),
      theme: boolOr(cap.theme, d.capture.theme),
      tools: boolOr(cap.tools, d.capture.tools),
    },
  };
}
