import { el } from './dom';
import type { NavMode } from '../render/NavController';

export interface NavBarCallbacks {
  /** The user picked a navigation mode. */
  onMode: (mode: NavMode) => void;
  /** The speed multiplier slider changed. */
  onSpeed: (multiplier: number) => void;
}

interface ModeDef {
  mode: NavMode;
  label: string;
  hint: string;
}

const MODES: ModeDef[] = [
  { mode: 'orbit', label: 'Orbit', hint: 'Inspect from outside — drag to rotate, scroll to zoom' },
  { mode: 'walk', label: 'Walk', hint: 'First-person — WASD on the level, Space/C to change height' },
  { mode: 'fly', label: 'Fly', hint: 'Free flight — WASD follows where you look' },
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

  private readonly _cb: NavBarCallbacks;
  private readonly _hud: HTMLElement;
  private readonly _speed: HTMLElement;
  private readonly _modeButtons = new Map<NavMode, HTMLButtonElement>();

  private _mode: NavMode = 'orbit';
  private _locked = false;
  private _helpPinned = false;
  private _hintTimer: number | null = null;

  constructor(callbacks: NavBarCallbacks) {
    this._cb = callbacks;

    // ── Mode switcher (segmented control) ─────────────────────────────────
    const segments = MODES.map((def) => {
      const button = el('button', {
        className: 'olv-mode',
        text: def.label,
        title: def.hint,
      });
      button.addEventListener('click', () => {
        button.blur(); // return focus to the body so keyboard nav still works
        this._cb.onMode(def.mode);
      });
      this._modeButtons.set(def.mode, button);
      return button;
    });
    const switcher = el('div', { className: 'olv-modes' }, segments);

    // ── Speed slider (walk / fly only) ────────────────────────────────────
    const slider = el('input', { className: 'olv-slider olv-speed-slider', type: 'range' });
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
    this._hud = el('div', { className: 'olv-nav-hud' }, [
      el('div', { className: 'olv-nav-hud-title', text: 'Navigation' }),
      el('div', { className: 'olv-legend' }, [
        legendItem(['W', 'A', 'S', 'D'], 'Move'),
        legendItem(['Mouse'], 'Look'),
        legendItem(['Shift'], 'Faster'),
        legendItem(['Space'], 'Up'),
        legendItem(['C'], 'Down'),
        legendItem(['Esc'], 'Release cursor'),
        legendItem(['1', '2', '3'], 'Modes'),
        legendItem(['R'], 'Reset'),
        legendItem(['F'], 'Focus'),
        legendItem(['H'], 'Toggle this'),
      ]),
    ]);

    // Project version, shown beside the mode switcher.
    const version = el('span', {
      className: 'olv-nav-version',
      text: `v${__APP_VERSION__}`,
      title: `OpenLiDARViewer ${__APP_VERSION__}`,
    });

    this.element = el('div', { className: 'olv-navbar' }, [
      this._hud,
      el('div', { className: 'olv-nav-row' }, [switcher, version, this._speed]),
    ]);

    this.prompt = el('div', { className: 'olv-nav-prompt' }, [
      el('span', { text: 'Click the scan to look around' }),
      el('span', { className: 'olv-nav-prompt-sub', text: 'WASD to move · Esc to release' }),
    ]);

    this._render();
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

  /** Toggle the controls HUD (the `H` key / help action). */
  toggleHelp(): void {
    this._helpPinned = !this._helpPinned;
    this._render();
  }

  /** Briefly reveal the HUD when a scan opens, then let it fade back. */
  flashHelp(): void {
    this._helpPinned = true;
    this._render();
    if (this._hintTimer !== null) clearTimeout(this._hintTimer);
    this._hintTimer = window.setTimeout(() => {
      this._helpPinned = false;
      this._render();
    }, 5200);
  }

  /** Apply all derived visibility — single source of truth for the UI state. */
  private _render(): void {
    for (const [mode, button] of this._modeButtons) {
      button.classList.toggle('olv-mode-active', mode === this._mode);
    }
    const navigating = this._mode !== 'orbit';
    this._speed.classList.toggle('olv-hidden', !navigating);
    // HUD shows while navigating, or when the user pinned it with H.
    this._hud.classList.toggle('olv-hidden', !(navigating || this._helpPinned));
    // The prompt appears only when navigating without the cursor captured.
    this.prompt.classList.toggle('olv-visible', navigating && !this._locked);
  }
}
