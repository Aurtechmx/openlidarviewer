/**
 * DesktopWorkspace.ts
 *
 * The desktop left-rail workspace shell: a semantic Data · Tools · Analyse ·
 * Export tablist over four mode-host slots the composition root re-parents the
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
import { buildTablist, type Tablist } from '../tablist';
import { publishGutterWidth } from './scrollbarGutter';

/** The semantic workspace modes, in display order. */
export type WorkspaceMode = 'data' | 'work' | 'analyse' | 'output';

interface ModeDef {
  readonly id: WorkspaceMode;
  readonly label: string;
  /** Hover text saying what the tab holds, so the four labels are not a guess. */
  readonly title: string;
}

/**
 * The tab order — Data (layers, classes) → Work (the scene-work tools:
 * measurement, annotation, clip) → Analyse → Export. Splitting Tools out of Data
 * keeps Data about what the scan IS and Tools about what you DO to it, so
 * neither tab carries the other's clutter.
 *
 * The visible labels and the mode ids are deliberately allowed to differ. The
 * ids are a persisted contract (`olv.workspace.left.mode`) and a selector
 * contract for the panels and the e2e suite; renaming them to chase a label
 * would strand every stored preference on the fallback for no user-visible
 * gain, so `work` still means the Tools tab and `output` the Export tab.
 */
const MODES: readonly ModeDef[] = [
  { id: 'data', label: 'Data', title: 'What the scan is: layers, their health, and the classes it carries.' },
  { id: 'work', label: 'Tools', title: 'What you do to it: measure, inspect, annotate, clip.' },
  { id: 'analyse', label: 'Analyse', title: 'Terrain analysis, contours and the products a run yields.' },
  { id: 'output', label: 'Export', title: 'Write the scan, the rasters, the reports and the session out.' },
];

const MODE_IDS: readonly WorkspaceMode[] = MODES.map((m) => m.id);

/** The default persistence key for the active left-workspace mode. */
export const WORKSPACE_MODE_KEY = 'olv.workspace.left.mode';

/** A minimal storage surface — the subset of `localStorage` this uses. */
export interface WorkspaceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The live panel elements the desktop layout hosts, by role. Lazy panels
 * (measure/analyse/object) may be absent until they mount.
 */
export interface WorkspacePanels {
  readonly dataLayers: HTMLElement;
  readonly dataLayerHealth: HTMLElement;
  readonly classLegend: HTMLElement;
  readonly annotation: HTMLElement;
  /** The Tools-tab launcher card; leads the work mode when present. */
  readonly toolLauncher?: HTMLElement | null;
  readonly clip: HTMLElement;
  readonly processStudio: HTMLElement;
  readonly export: HTMLElement;
  readonly measure?: HTMLElement | null;
  readonly analyse?: HTMLElement | null;
  readonly object?: HTMLElement | null;
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

  private readonly _tablist: Tablist<WorkspaceMode>;
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
    this._tablist = buildTablist<WorkspaceMode>({
      items: MODES,
      tablistClassName: 'olv-ws-tabs',
      tablistLabel: 'Workspace',
      tabClassName: 'olv-ws-tab',
      tabId: (id) => `olv-ws-tab-${id}`,
      panelId: (id) => `olv-ws-mode-${id}`,
      setDataset: (tab, id) => { tab.dataset.mode = id; },
      activate: (id) => this.setMode(id),
    });

    // ── mode-host slots (one tabpanel per mode) ──────────────────────────────
    const body = el('div', { className: 'olv-ws-body' });
    // This body reserves a scrollbar gutter, and how wide that is depends on
    // the platform. Publish it so the rail handle can sit against the card's
    // real edge instead of the rail's, which is what left a strip of scene
    // between the panel and its own collapse control on Chrome.
    publishGutterWidth();
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
    this.element = el('div', { className: 'olv-left-panels' }, [this._tablist.element, body]);
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

  /**
   * Place every desktop panel into its mode in canonical order, re-parenting the
   * live nodes. Called on first build and whenever the layout returns from the
   * mobile sheet, so the panel→mode mapping lives here, not scattered in the
   * composition root. Lazy panels (measure/analyse/object) are placed only once
   * they exist; they otherwise route themselves in via {@link mountInMode}.
   */
  layoutDesktop(p: WorkspacePanels): void {
    this.mountInMode('data', p.dataLayers);
    this.mountInMode('data', p.dataLayerHealth);
    this.mountInMode('data', p.classLegend);
    // Work carries the scene-work tools: measurement, annotation, clip. The
    // launcher leads, so the tab names its tools before any of them is used.
    if (p.toolLauncher) this.mountInMode('work', p.toolLauncher);
    if (p.measure) this.mountInMode('work', p.measure);
    this.mountInMode('work', p.annotation);
    this.mountInMode('work', p.clip);
    this.mountInMode('analyse', p.processStudio);
    if (p.analyse) this.mountInMode('analyse', p.analyse);
    if (p.object) this.mountInMode('analyse', p.object);
    this.mountInMode('output', p.export);
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

  /**
   * Reflect the active mode onto tabs and hosts. Active state is carried by
   * BOTH `aria-selected`/`is-active` and the always-visible text label, so it
   * is never signalled by colour alone (forced-colors safe).
   */
  private _syncTabs(): void {
    this._tablist.sync(this._mode);
    for (const { id } of MODES) {
      this._hosts.get(id)?.classList.toggle('is-active', id === this._mode);
    }
  }
}
