import { el } from './dom';
import type { NavMode } from '../render/NavController';
import {
  CAMERA_PRESET_KEY,
  CAMERA_PRESET_LABEL,
  CAMERA_PRESET_ORDER,
  type CameraPresetName,
} from '../render/camera/cameraPresets';

export interface NavBarCallbacks {
  /** The user picked a navigation mode. */
  onMode: (mode: NavMode) => void;
  /** The speed multiplier slider changed. */
  onSpeed: (multiplier: number) => void;
  /**
   * The user tapped the centre Reset button — restore the framing-pose
   * tween that opens a freshly-loaded scan (Viewer.frameAll()).
   */
  onReset: () => void;
  /**
   * The user tapped a smart camera preset chip (Top / Iso / Oblique /
   * Planar) — see `src/render/camera/cameraPresets.ts` for the pure
   * geometry. The same handler fires for T / I / O / P keyboard
   * shortcuts in main.ts.
   */
  onCameraPreset: (name: CameraPresetName) => void;
}

interface ModeDef {
  mode: NavMode;
  label: string;
  hint: string;
  /**
   * Where the mode sits on the triangle, in screen-reader-friendly
   * prose. The triangle has Orbit at the top vertex, Walk at the
   * bottom-left vertex, and Fly at the bottom-right vertex (see the
   * SVG polygon coordinates below). Folded into each button's
   * `aria-label` so a screen-reader user can navigate the spatial
   * arrangement the same way a sighted user does.
   * v0.3.10 a11y patch #376.
   */
  spatial: string;
  /** Monoline SVG icon — 24×24 viewBox, `currentColor` stroke. */
  icon: string;
}

const MODES: ModeDef[] = [
  {
    mode: 'orbit',
    label: 'Orbit',
    spatial: 'top of triangle',
    hint: 'Inspect from outside — drag to rotate, scroll to zoom, double-click to focus on a point',
    // Curved arrow orbiting a central point.
    icon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<circle cx="12" cy="12" r="3" fill="currentColor"/>
<path d="M 4.5 12 A 7.5 7.5 0 0 1 19.5 12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
<path d="M 19.5 12 A 7.5 7.5 0 0 1 8 17.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" opacity="0.45"/>
<path d="M 17 7 L 19.5 12 L 14.5 11.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
  {
    mode: 'walk',
    label: 'Walk',
    spatial: 'bottom-left of triangle',
    hint: 'First-person — WASD on the level, Space/C to change height',
    // Walking figure — simple stick + leg motion.
    icon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<circle cx="13" cy="4.5" r="2" fill="currentColor"/>
<path d="M 13 6.5 L 13 13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M 13 13 L 9.5 19.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M 13 13 L 16.5 19.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M 13 9 L 9 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
<path d="M 13 9 L 17.5 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  },
  {
    mode: 'fly',
    label: 'Fly',
    spatial: 'bottom-right of triangle',
    hint: 'Free flight — WASD follows where you look',
    // Paper-plane in motion.
    icon: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
<path d="M 3 12 L 21 4 L 14 21 L 12 13 L 3 12 Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
<path d="M 12 13 L 21 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" opacity="0.55"/></svg>`,
  },
];

/** One key-cap + caption pair for the controls HUD. */
function legendItem(keys: string[], caption: string): HTMLElement {
  const caps = keys.map((k) => el('kbd', { className: 'olv-key', text: k }));
  return el('span', { className: 'olv-legend-item' }, [
    ...caps,
    el('span', { className: 'olv-legend-text', text: caption }),
  ]);
}

/**
 * The bottom-centre navigation bar: a three-way mode switcher (Orbit / Walk /
 * Fly), a speed slider for walk & fly, a glassy controls HUD, and a centred
 * "click to look" prompt shown until the pointer is locked.
 */
export class NavBar {
  /** The bottom-centre cluster — append to the stage overlay. */
  readonly element: HTMLElement;
  /** The centred "click to look around" prompt — append to the stage overlay. */
  readonly prompt: HTMLElement;
  /**
   * The touch-gesture hint shown on phones in place of the keyboard HUD —
   * append to the stage overlay. Styled visible only on small screens.
   */
  readonly touchHint: HTMLElement;

  private readonly _cb: NavBarCallbacks;
  private readonly _hud: HTMLElement;
  private readonly _speed: HTMLElement;
  private readonly _modeButtons = new Map<NavMode, HTMLButtonElement>();

  private _mode: NavMode = 'orbit';
  private _locked = false;
  private _measuring = false;
  // v0.3.10 — Default visible. The X close button in the title row
  // and the H keyboard shortcut both flip this; flashHelp() is a no-op
  // when already pinned. Camera presets and the legend stay on screen
  // until the user explicitly dismisses them.
  private _helpPinned = true;
  private _hintTimer: number | null = null;
  private _touchTimer: number | null = null;

  constructor(callbacks: NavBarCallbacks) {
    this._cb = callbacks;

    // ── Mode triangle ─────────────────────────────────────────────────────
    // v0.3.6 discoverability fix: the previous flat segmented control was
    // a low-contrast row of three text labels that most users never
    // noticed. The triangle composition makes the trio read as a single
    // navigation tool — three vertex buttons connected by a dashed cyan
    // outline, with a centre Reset action at the triangle's centroid.
    const triangleOutline = el('div', {
      className: 'olv-modes-tri-bg',
      unsafeHtml: `<svg viewBox="0 0 140 110" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<polygon points="70,18 22,92 118,92" fill="none" stroke="rgba(0,178,255,0.32)" stroke-width="1.1" stroke-dasharray="3 4" stroke-linejoin="round"/>
<polygon points="70,18 22,92 118,92" fill="rgba(0,178,255,0.025)" stroke="none"/>
</svg>`,
    });
    const segments = MODES.map((def) => {
      // v0.3.10 a11y patch #376 — the icon SVG is decorative (the
      // visible text label below carries the meaning); marking the
      // wrapper `aria-hidden="true"` keeps screen readers from
      // narrating the SVG markup.
      const iconWrap = el('span', { className: 'olv-mode-icon', unsafeHtml: def.icon });
      iconWrap.setAttribute('aria-hidden', 'true');
      const labelEl = el('span', { className: 'olv-mode-label', text: def.label });
      const button = el('button', {
        className: `olv-mode olv-mode-${def.mode}`,
        title: def.hint,
        // Spatial aria-label: a sighted user sees Orbit at the top
        // vertex of the triangle, Walk bottom-left, Fly bottom-right.
        // A screen-reader user gets the same arrangement spelled out,
        // plus the hint so they don't have to hover to learn what the
        // mode does. v0.3.10 a11y patch #376.
        ariaLabel: `${def.label} mode, ${def.spatial}. ${def.hint}`,
      }, [iconWrap, labelEl]);
      // `aria-pressed` is the canonical attribute for a toggle button
      // — `_render()` flips it whenever the active mode changes so
      // assistive tech announces the new state.
      button.setAttribute('aria-pressed', def.mode === this._mode ? 'true' : 'false');
      button.addEventListener('click', () => {
        button.blur();
        this._cb.onMode(def.mode);
      });
      this._modeButtons.set(def.mode, button);
      return button;
    });
    // Centre Reset button — sits at the triangle's centroid. Compact,
    // ringed in cyan so it reads as a peer to the three modes without
    // competing for primary attention.
    const resetBtn = el('button', {
      className: 'olv-mode-reset',
      title: 'Frame the whole scan (R) — reset the camera to fit the entire cloud',
      ariaLabel: 'Frame the whole scan',
    });
    resetBtn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/>
<circle cx="12" cy="12" r="2" fill="currentColor"/>
<line x1="12" y1="2" x2="12" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<line x1="12" y1="18" x2="12" y2="22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<line x1="2" y1="12" x2="6" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
<line x1="18" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
    resetBtn.addEventListener('click', () => {
      resetBtn.blur();
      this._cb.onReset();
    });
    const switcher = el('div', { className: 'olv-modes olv-modes-triangle' }, [
      triangleOutline,
      resetBtn,
      ...segments,
    ]);
    // v0.3.10 a11y patch #376 — group the three mode buttons + the
    // centre Reset under one role with a name that describes the
    // spatial arrangement. Screen-reader users hear "Navigation
    // mode, group" when entering the cluster instead of three
    // unrelated toggles plus a reset button.
    switcher.setAttribute('role', 'group');
    switcher.setAttribute(
      'aria-label',
      'Navigation mode — Orbit (top), Walk (bottom-left), Fly (bottom-right). ' +
        'The centre button resets the camera to fit the whole scan.',
    );

    // ── Speed slider (walk / fly only) ────────────────────────────────────
    const slider = el('input', {
      className: 'olv-slider olv-speed-slider',
      type: 'range',
      title: 'Drag to set how fast Walk and Fly movement is — Shift also sprints',
    });
    slider.min = '0.25';
    slider.max = '4';
    slider.step = '0.25';
    slider.value = '1';
    const readout = el('span', { className: 'olv-speed-readout', text: '1.0×' });
    slider.addEventListener('input', () => {
      readout.textContent = `${slider.valueAsNumber.toFixed(1)}×`;
      this._cb.onSpeed(slider.valueAsNumber);
    });
    this._speed = el('div', { className: 'olv-nav-speed' }, [
      el('span', { className: 'olv-nav-speed-label', text: 'Speed' }),
      slider,
      readout,
    ]);

    // ── Controls HUD ──────────────────────────────────────────────────────
    // Gestalt proximity: 10 shortcut items split into three clusters by
    // role, each cluster a separate flex sub-row.
    //   1. Movement — Move / Look / Faster / Up / Down
    //   2. Modes    — Esc (release cursor), 1/2/3 (mode switch)
    //   3. Meta     — Reset / Focus / Toggle HUD
    // The user reads three intents instead of one wall of ten chips.
    const movementGroup = el('div', { className: 'olv-legend-group' }, [
      legendItem(['W', 'A', 'S', 'D'], 'Move'),
      legendItem(['Mouse'], 'Look'),
      legendItem(['Shift'], 'Faster'),
      legendItem(['Space'], 'Up'),
      legendItem(['C'], 'Down'),
    ]);
    const modesGroup = el('div', { className: 'olv-legend-group' }, [
      legendItem(['Esc'], 'Release cursor'),
      legendItem(['1', '2', '3'], 'Modes'),
    ]);
    const metaGroup = el('div', { className: 'olv-legend-group' }, [
      legendItem(['R'], 'Reset'),
      legendItem(['F'], 'Focus'),
      legendItem(['H'], 'Toggle this'),
    ]);
    // v0.3.9 Smart camera presets — four buttons (T / I / O / P) that
    // jump the camera to a named pose. Mounted in the HUD so they
    // sit next to the navigation legend (Gestalt proximity: both
    // surfaces are "ways to move the camera around"), and so a user
    // who never touches the keyboard still discovers them.
    const cameraPresetsRow = el('div', { className: 'olv-cam-presets' });
    for (const name of CAMERA_PRESET_ORDER) {
      // An empty key means "no keyboard binding" (Iso lost bare `I` to the
      // Inspect tool in v0.4.4) — skip the key chip and shortcut hint then.
      const key = CAMERA_PRESET_KEY[name];
      const label = CAMERA_PRESET_LABEL[name];
      const btn = el('button', {
        className: 'olv-cam-chip',
        title: key ? `${label} view — keyboard shortcut: ${key}` : `${label} view`,
        ariaLabel: key ? `${label} camera view (${key})` : `${label} camera view`,
      });
      if (key) {
        btn.append(el('span', { className: 'olv-cam-chip-key', text: key }));
      }
      btn.append(el('span', { className: 'olv-cam-chip-label', text: label }));
      btn.addEventListener('click', () => {
        btn.blur();
        callbacks.onCameraPreset(name);
      });
      cameraPresetsRow.append(btn);
    }
    // v0.3.10 — Explicit dismiss control. The `H Toggle this` legend
    // item teaches the keyboard shortcut, but discoverability is poor
    // for users who haven't read it. An X in the title row turns the
    // HUD into a normal closable panel that users already understand,
    // and the same toggle still listens to the H key (and the Help
    // button in the dock surfaces the shortcut).
    const hudDismiss = el('button', {
      className: 'olv-nav-hud-close',
      text: '×',
      title: 'Hide navigation help (H)',
      ariaLabel: 'Hide navigation help',
    });
    hudDismiss.addEventListener('click', () => {
      hudDismiss.blur();
      this.toggleHelp();
    });
    const hudHeader = el('div', { className: 'olv-nav-hud-header' }, [
      el('div', { className: 'olv-nav-hud-title', text: 'Navigation' }),
      hudDismiss,
    ]);
    this._hud = el('div', { className: 'olv-nav-hud' }, [
      hudHeader,
      el('div', { className: 'olv-legend' }, [movementGroup, modesGroup, metaGroup]),
      el('div', { className: 'olv-cam-presets-row' }, [
        el('span', { className: 'olv-cam-presets-label', text: 'Camera' }),
        cameraPresetsRow,
      ]),
    ]);

    this.element = el('div', { className: 'olv-navbar' }, [
      this._hud,
      el('div', { className: 'olv-nav-row' }, [switcher, this._speed]),
    ]);

    this.prompt = el('div', { className: 'olv-nav-prompt' }, [
      el('span', { text: 'Click the scan to look around' }),
      el('span', { className: 'olv-nav-prompt-sub', text: 'WASD to move · Esc to release' }),
    ]);

    // ── Touch-gesture hint (phones) ───────────────────────────────────────
    const touchDismiss = el('button', {
      className: 'olv-touch-hint-x',
      text: '×',
      ariaLabel: 'Dismiss',
    });
    touchDismiss.addEventListener('click', () => this.hideTouchHint());
    this.touchHint = el('div', { className: 'olv-touch-hint' }, [
      el('span', { text: 'Drag to rotate · Pinch to zoom · Two fingers to pan' }),
      touchDismiss,
    ]);

    this._render();
  }

  /**
   * Briefly reveal the touch-gesture hint (phones only — styling keeps it
   * hidden on larger screens), then let it fade away on its own.
   */
  flashTouchHint(): void {
    this.touchHint.classList.add('olv-visible');
    if (this._touchTimer !== null) clearTimeout(this._touchTimer);
    this._touchTimer = window.setTimeout(() => this.hideTouchHint(), 6500);
  }

  /** Dismiss the touch-gesture hint. */
  hideTouchHint(): void {
    if (this._touchTimer !== null) {
      clearTimeout(this._touchTimer);
      this._touchTimer = null;
    }
    this.touchHint.classList.remove('olv-visible');
  }

  /** Reflect the current navigation mode (no callback fired). */
  setMode(mode: NavMode): void {
    this._mode = mode;
    this._render();
  }

  /** Reflect the pointer-lock state. */
  setLocked(locked: boolean): void {
    this._locked = locked;
    this._render();
  }

  /**
   * Reflect whether the Measure tool is active. While measuring, the
   * "click to look around" prompt is suppressed — clicks pick points.
   */
  setMeasuring(measuring: boolean): void {
    this._measuring = measuring;
    this._render();
  }

  /** Toggle the controls HUD (the `H` key / help action). */
  toggleHelp(): void {
    this._helpPinned = !this._helpPinned;
    this._render();
  }

  /**
   * Re-show the HUD when a scan opens. v0.3.10 — no auto-hide timer.
   * The user dismisses via the X in the title row or the H shortcut;
   * a silent auto-hide would fight the X button (clicking X, then
   * having the HUD come back, then auto-close = surprising).
   */
  flashHelp(): void {
    this._helpPinned = true;
    if (this._hintTimer !== null) {
      clearTimeout(this._hintTimer);
      this._hintTimer = null;
    }
    this._render();
  }

  /** Apply all derived visibility — single source of truth for the UI state. */
  private _render(): void {
    for (const [mode, button] of this._modeButtons) {
      const active = mode === this._mode;
      button.classList.toggle('olv-mode-active', active);
      // v0.3.10 a11y patch #376 — keep `aria-pressed` in sync with the
      // visible active state so screen readers announce mode changes.
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
    const navigating = this._mode !== 'orbit';
    this._speed.classList.toggle('olv-hidden', !navigating);
    // v0.3.10: HUD visibility now follows `_helpPinned`. The flashHelp
    // call on scan load primes it true so the legend + camera presets
    // are visible by default; pressing H or clicking the X in the
    // title row toggles it off. The Help button in the dock and the
    // command palette surface H as the re-open shortcut.
    this._hud.classList.toggle('olv-hidden', !this._helpPinned);
    // The prompt appears only when navigating without the cursor captured —
    // and never while the Measure tool owns clicks.
    this.prompt.classList.toggle(
      'olv-visible',
      navigating && !this._locked && !this._measuring,
    );
  }
}
