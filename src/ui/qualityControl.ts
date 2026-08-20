/**
 * qualityControl.ts
 *
 * The eager half of the Speed ↔ Quality control: the header button, the
 * preference it holds, and the apply path that pushes resolved settings at the
 * renderer. Small on purpose — the popover markup lives in `QualityPanel.ts`
 * and arrives through `loadQualityPanel()` on the first click.
 *
 * The split is not cosmetic. The boot-time apply cannot wait for a click: a
 * weak device has to get its degraded display settings (no Eye Dome Lighting,
 * no antialiasing, a lower resolution ceiling) on the first frame, which is
 * what the shell used to do by hand for `tier === 'low'`. So the policy, the
 * stored preference and the apply are eager; only the DOM is deferred.
 *
 * Scope is the policy module's to state and this module's to respect: every
 * setting applied here is display or streaming. Nothing it touches reaches a
 * measured number. See `src/render/quality/qualityPolicy.ts`.
 */

import { el } from './dom';
import { loadQualityPanel } from '../lazyChunks';
import type { QualityPanel } from './QualityPanel';
import {
  resolveQualitySettings,
  type QualityDevice,
  type QualityPreference,
  type QualitySettings,
} from '../render/quality/qualityPolicy';
import type { StreamingQuality } from '../render/streaming/streamingBudget';

/** Gauge glyph: a dial arc with a needle. Static markup, no interpolation. */
const ICON_QUALITY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.6" stroke-linecap="round" aria-hidden="true" focusable="false">
  <path d="M4 17a8.4 8.4 0 1 1 16 0"/>
  <path d="M12 17 16.2 11.4"/>
</svg>`;

export interface QualityControlOptions {
  /** What the renderer settled on — drives the automatic position. */
  readonly device: QualityDevice;
  /** The persisted preference, or the default. */
  readonly preference: QualityPreference;
  /**
   * Fired whenever the resolved settings change. `userInitiated` is false for
   * the apply that happens at construction, so a caller can distinguish
   * "restore what was already chosen" from "the user just moved something" —
   * which matters at boot, where persisting on the initial apply would
   * overwrite preferences that have not been read back yet.
   */
  onApply(settings: QualitySettings, userInitiated: boolean): void;
  /** Persist the preference. Fired only for user-initiated changes. */
  onPersist?(preference: QualityPreference): void;
  /**
   * The streaming preset the rest of the app is actually running. The Streaming
   * panel's Quality chips write the same setting, so on open the control adopts
   * a value chosen over there as a pinned Advanced field instead of showing a
   * different preset from the one in force.
   */
  liveStreamingQuality?(): StreamingQuality;
}

export class QualityControl {
  /** The header mount — the button, plus the panel once it has been opened. */
  readonly element: HTMLElement;

  private _device: QualityDevice;
  private _preference: QualityPreference;
  private _panel: QualityPanel | null = null;
  private _open = false;
  /** In-flight lazy import, so a double click loads the chunk once. */
  private _loading: Promise<QualityPanel> | null = null;

  private readonly _options: QualityControlOptions;
  private readonly _button: HTMLButtonElement;
  private readonly _onDocumentPointerDown: (event: Event) => void;
  private readonly _onDocumentKeyDown: (event: KeyboardEvent) => void;

  constructor(options: QualityControlOptions) {
    this._options = options;
    this._device = options.device;
    this._preference = options.preference;

    this._button = el('button', {
      className: 'olv-quality-button',
      unsafeHtml: ICON_QUALITY,
      title: 'Performance',
      ariaLabel: 'Performance settings',
    }) as HTMLButtonElement;
    this._button.type = 'button';
    this._button.setAttribute('aria-expanded', 'false');
    this._button.setAttribute('aria-haspopup', 'dialog');
    this._button.addEventListener('click', () => { void this.toggle(); });

    this.element = el('div', { className: 'olv-quality' }, [this._button]);

    // Dismissal: a pointer outside the control, or Escape anywhere. Bound once
    // and removed by `dispose`, so a torn-down Stage leaves no listener behind.
    this._onDocumentPointerDown = (event: Event): void => {
      if (!this._open) return; // every pointerdown in the app reaches here.
      const target = event.target;
      if (target instanceof Node && this.element.contains(target)) return;
      this.close();
    };
    this._onDocumentKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !this._open) return;
      this.close();
      this._button.focus();
    };
    document.addEventListener('pointerdown', this._onDocumentPointerDown, true);
    document.addEventListener('keydown', this._onDocumentKeyDown);

    this._options.onApply(this.settings(), false);
  }

  /** The settings the current preference resolves to on the current device. */
  settings(): QualitySettings {
    return resolveQualitySettings(this._preference, this._device);
  }

  /** The current preference — what a caller would persist. */
  get preference(): QualityPreference {
    return this._preference;
  }

  /** Whether the panel is showing. */
  get isOpen(): boolean {
    return this._open;
  }

  /**
   * Re-resolve against a device fact that only became known later (the render
   * backend settles after the first GPU init). Applies without persisting: the
   * user chose nothing here.
   */
  setDevice(device: QualityDevice): void {
    this._device = device;
    this._panel?.render(this._preference, this.settings());
    this._options.onApply(this.settings(), false);
  }

  /** Show the panel, loading its chunk on first use. */
  async open(): Promise<void> {
    const panel = await this._ensurePanel();
    // Adopt a preset chosen in the Streaming panel since the last look, so the
    // Advanced chips never contradict what is actually in force. Silent: the
    // user did choose it, just not here, and it is already applied.
    const live = this._options.liveStreamingQuality?.();
    if (live && live !== this.settings().streamingQuality) {
      this._preference = {
        ...this._preference,
        overrides: { ...this._preference.overrides, streamingQuality: live },
      };
    }
    panel.render(this._preference, this.settings());
    panel.element.hidden = false;
    this._setOpenState(true);
  }

  /** Hide the panel. Safe before the chunk has ever loaded. */
  close(): void {
    if (this._panel) this._panel.element.hidden = true;
    this._setOpenState(false);
  }

  /** Toggle the panel. The button's handler. */
  async toggle(): Promise<void> {
    if (this._open) this.close();
    else await this.open();
  }

  /** Drop the document listeners this control installed. */
  dispose(): void {
    document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
    document.removeEventListener('keydown', this._onDocumentKeyDown);
  }

  /** Build the panel on first open; later opens reuse it. */
  private async _ensurePanel(): Promise<QualityPanel> {
    if (this._panel) return this._panel;
    if (!this._loading) {
      this._loading = loadQualityPanel().then((module) => {
        const panel = new module.QualityPanel({
          onPreference: (patch) => this._update(patch),
          onPin: (field) => this._update({ overrides: { ...this._preference.overrides, ...field } }),
        });
        panel.element.hidden = true;
        this.element.append(panel.element);
        this._panel = panel;
        return panel;
      });
    }
    return this._loading;
  }

  /** Merge a preference patch, repaint, apply, and persist — always user-initiated. */
  private _update(patch: Partial<QualityPreference>): void {
    this._preference = { ...this._preference, ...patch };
    this._panel?.render(this._preference, this.settings());
    this._options.onApply(this.settings(), true);
    this._options.onPersist?.(this._preference);
  }

  private _setOpenState(open: boolean): void {
    this._open = open;
    this._button.setAttribute('aria-expanded', open ? 'true' : 'false');
    this._button.classList.toggle('olv-quality-button-open', open);
  }
}
