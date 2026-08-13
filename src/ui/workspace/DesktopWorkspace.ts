/**
 * DesktopWorkspace.ts
 *
 * The desktop left-rail workspace shell: a semantic Data · Work · Analyse ·
 * Output tablist over four mode-host slots the composition root re-parents the
 * existing live panels into. It replaces the flat vertical stack of
 * `.olv-left-panels` with one mode visible at a time, WITHOUT changing what any
 * panel is or does — the workspace orchestrates presentation only. It owns no
 * point clouds, no CRS, no classification, no processing capability; those stay
 * with their existing services (ScanService / LayerService / ProcessService /
 * Inspector …).
 *
 * Contract preservation: the root element keeps the class `olv-left-panels` and
 * `id="olv-left-panels"` so the existing rail-collapse chrome
 * (`wireRailToggle` with `olv.leftRail.collapsed`, `aria-controls`), the
 * dock/measure-bar clearance vars, and the panel-wheel containment all continue
 * to target it unchanged. Reorganisation happens INSIDE that host, not by
 * replacing it.
 *
 * Node identity: `mode(m)` returns a stable container per mode for the lifetime
 * of the workspace. Switching modes toggles visibility (an `is-active` class +
 * `aria-selected`), never recreates a host — so a live panel re-parented into a
 * mode survives every mode switch as the exact same DOM node, keeping its
 * listeners and internal state. This mirrors the MobileSheet re-parenting
 * invariant on the desktop side.
 *
 * Pure DOM via {@link el}; no three.js, no app singletons — unit-testable with
 * the recording-stub document the other UI tests use.
 */

import { el } from '../dom';

/** The four semantic workspace modes, in display order. */
export type WorkspaceMode = 'data' | 'work' | 'analyse' | 'output';

interface ModeDef {
  readonly id: WorkspaceMode;
  readonly label: string;
}

/** The tab order — matches the FIND → WORK → ANALYSE → OUTPUT task flow. */
const MODES: readonly ModeDef[] = [
  { id: 'data', label: 'Data' },
  { id: 'work', label: 'Work' },
  { id: 'analyse', label: 'Analyse' },
  { id: 'output', label: 'Output' },
];

const MODE_IDS: readonly WorkspaceMode[] = MODES.map((m) => m.id);

/** The default persistence key for the active left-workspace mode. */
export const WORKSPACE_MODE_KEY = 'olv.workspace.left.mode';

/** A minimal storage surface — the subset of `localStorage` this uses. */
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface DesktopWorkspaceOptions {
  /** The mode to start on. Overridden by a persisted choice when one exists. */
  readonly initialMode?: WorkspaceMode;
  /** Persistence key for the active mode. Defaults to {@link WORKSPACE_MODE_KEY}. */
  readonly storageKey?: string;
  /**
   * Where to persist the active mode. Defaults to `globalThis.localStorage`
   * when present; injectable so tests need no real storage. A throwing or
   * absent store degrades to in-memory (private-mode safe).
   */
  readonly storage?: WorkspaceStorage;
  /** Notified after the active mode actually changes. */
  readonly onModeChange?: (mode: WorkspaceMode) => void;
}

/** `true` when `v` is one of the four workspace modes. */
export function isWorkspaceMode(v: unknown): v is WorkspaceMode {
  return typeof v === 'string' && (MODE_IDS as readonly string[]).includes(v);
}

/**
 * Resolve the store to use: an explicit one, else `localStorage` if reachable,
 * else `null` (in-memory only). Reading `localStorage` can throw in a sandboxed
 * frame, so it is guarded.
 */
function resolveStorage(explicit?: WorkspaceStorage): WorkspaceStorage | null {
  if (explicit) return explicit;
  try {
    const ls = (globalThis as { localStorage?: WorkspaceStorage }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

export class DesktopWorkspace {
  /** The rail root — the host appends this to the overlay (`.olv-left-panels`). */
  readonly element: HTMLElement;

  private readonly _tabs = new Map<WorkspaceMode, HTMLButtonElement>();
  private readonly _hosts = new Map<WorkspaceMode, HTMLElement>();
  private readonly _onModeChange?: (mode: WorkspaceMode) => void;
  private readonly _storage: WorkspaceStorage | null;
  private readonly _storageKey: string;
  private _mode: WorkspaceMode;

  constructor(opts: DesktopWorkspaceOptions = {}) {
    this._onModeChange = opts.onModeChange;
    this._storageKey = opts.storageKey ?? WORKSPACE_MODE_KEY;
    this._storage = resolveStorage(opts.storage);
    this._mode = this._initialMode(opts.initialMode ?? 'data');

    // ── tablist (the segmented mode selector) ────────────────────────────────
    const tablist = el('div', { className: 'olv-ws-tabs' });
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Workspace');
    for (const { id, label } of MODES) {
      const tab = el('button', { className: 'olv-ws-tab', text: label, type: 'button' });
      tab.setAttribute('role', 'tab');
      tab.dataset.mode = id;
      tab.id = `olv-ws-tab-${id}`;
      tab.setAttribute('aria-controls', `olv-ws-mode-${id}`);
      tab.addEventListener('click', () => this.setMode(id));
      tab.addEventListener('keydown', (ev) => this._onTabKey(ev as KeyboardEvent, id));
      this._tabs.set(id, tab);
      tablist.append(tab);
    }

    // ── mode-host slots (one tabpanel per mode) ──────────────────────────────
    const body = el('div', { className: 'olv-ws-body' });
    for (const { id } of MODES) {
      const host = el('div', { className: 'olv-ws-mode' });
      host.setAttribute('role', 'tabpanel');
      host.id = `olv-ws-mode-${id}`;
      host.dataset.mode = id;
      host.setAttribute('aria-labelledby', `olv-ws-tab-${id}`);
      this._hosts.set(id, host);
      body.append(host);
    }

    // Root keeps the legacy class + id so rail-collapse chrome, clearance
    // custom properties, and wheel containment target it unchanged.
    this.element = el('div', { className: 'olv-left-panels' }, [tablist, body]);
    this.element.id = 'olv-left-panels';

    this._syncTabs();
  }

  /**
   * Mark the workspace available (a scan is loaded) or not. When unavailable
   * the mode tab strip is hidden so an empty workspace collapses to zero height
   * and the rail-collapse grabber stays hidden in the start-screen empty state,
   * matching the pre-workspace behaviour. Presentation-only — the panels
   * themselves are shown/hidden by their own scan lifecycle.
   */
  setAvailable(available: boolean): void {
    this.element.classList.toggle('olv-ws-ready', available);
  }

  /** The live host container a mode's panels are re-parented into (stable). */
  mode(m: WorkspaceMode): HTMLElement {
    const host = this._hosts.get(m);
    if (!host) throw new Error(`DesktopWorkspace: unknown mode "${m}"`);
    return host;
  }

  /** The currently active mode. */
  getMode(): WorkspaceMode {
    return this._mode;
  }

  /** Select a mode (idempotent). Persists and notifies only on a real change. */
  setMode(m: WorkspaceMode): void {
    if (!this._hosts.has(m)) return;
    const changed = m !== this._mode;
    this._mode = m;
    this._syncTabs();
    if (changed) {
      this._persist(m);
      this._onModeChange?.(m);
    }
  }

  /**
   * Re-parent a live panel element into a mode host. `before`, when given and
   * currently a child of that host, positions the element ahead of it;
   * otherwise the element is appended. Never recreates the element — the same
   * node is moved, preserving its listeners and state.
   */
  mountInMode(m: WorkspaceMode, node: HTMLElement, before?: HTMLElement | null): void {
    const host = this.mode(m);
    if (before && before.parentElement === host) host.insertBefore(node, before);
    else host.append(node);
  }

  /**
   * Tear down. Phase-1 workspace holds no window/document/observer listeners
   * (every listener lives on its own children and dies with the element), so
   * this is a defensive no-op kept for a stable disposal contract.
   */
  dispose(): void {
    /* no external listeners to detach */
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private _initialMode(fallback: WorkspaceMode): WorkspaceMode {
    if (!this._storage) return fallback;
    try {
      const stored = this._storage.getItem(this._storageKey);
      return isWorkspaceMode(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  }

  private _persist(m: WorkspaceMode): void {
    if (!this._storage) return;
    try {
      this._storage.setItem(this._storageKey, m);
    } catch {
      /* private mode / quota — presentation preference is non-essential */
    }
  }

  private _onTabKey(ev: KeyboardEvent, id: WorkspaceMode): void {
    const idx = MODES.findIndex((m) => m.id === id);
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (idx + 1) % MODES.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (idx - 1 + MODES.length) % MODES.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = MODES.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    const target = MODES[next].id;
    this.setMode(target);
    this._tabs.get(target)?.focus();
  }

  /**
   * Reflect the active mode onto tabs and hosts. Active state is carried by
   * BOTH `aria-selected`/`is-active` and the always-visible text label, so it
   * is never signalled by colour alone (forced-colors safe).
   */
  private _syncTabs(): void {
    for (const { id } of MODES) {
      const active = id === this._mode;
      const tab = this._tabs.get(id);
      if (tab) {
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.setAttribute('tabindex', active ? '0' : '-1'); // roving tabindex
        tab.classList.toggle('is-active', active);
      }
      this._hosts.get(id)?.classList.toggle('is-active', active);
    }
  }
}
