/**
 * WorkflowConfigPanel.ts
 *
 * The small settings popup for the workflow recorder. A modal card (backdrop +
 * card, same shell as the shortcut sheet) exposing every recorder preference:
 * file format, save destination, the start/stop chord (live key-capture),
 * replay speed, a pre-record countdown, which action families are captured, and
 * loop replay. Every edit emits the full config so the host persists it and
 * re-applies it to the controller immediately.
 *
 * DOM-bound. Its data dependency is the pure {@link WorkflowRecorderConfig}.
 */

import { el } from './dom';
import {
  DEFAULT_WORKFLOW_CONFIG,
  WORKFLOW_REPLAY_SPEEDS,
  chordFromEvent,
  formatShortcutLabel,
  type WorkflowRecorderConfig,
  type WorkflowFormat,
  type WorkflowSaveMode,
} from '../render/workflow/workflowConfig';

const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** One option in a segmented control. */
interface Segment<T> {
  readonly value: T;
  readonly label: string;
}

export class WorkflowConfigPanel {
  /** The overlay element — mount into the stage overlay. */
  readonly element: HTMLElement;
  private readonly _card: HTMLElement;
  private readonly _backdrop: HTMLElement;

  /** A working copy of the config; edits mutate this then emit. */
  private _config: WorkflowRecorderConfig = DEFAULT_WORKFLOW_CONFIG;
  private _onChange: ((config: WorkflowRecorderConfig) => void) | null = null;
  private _open = false;

  /** True while the shortcut field is waiting for a key combination. */
  private _capturingShortcut = false;
  private _shortcutBtn!: HTMLButtonElement;
  /** Re-render hooks keyed by control, run when the config changes externally. */
  private _syncers: Array<() => void> = [];

  constructor() {
    const dismiss = el('button', {
      className: 'olv-wfc-close',
      text: '×',
      title: 'Close (Esc)',
      ariaLabel: 'Close workflow settings',
    });
    dismiss.addEventListener('click', () => this.close());

    const header = el('div', { className: 'olv-wfc-header' }, [
      el('div', { className: 'olv-wfc-header-titles' }, [
        el('div', { className: 'olv-wfc-title', text: 'Workflow recorder' }),
        el('div', {
          className: 'olv-wfc-subtitle',
          text: 'Records camera moves and tool actions — never scan data.',
        }),
      ]),
      dismiss,
    ]);

    const body = el('div', { className: 'olv-wfc-body' }, [
      this._segmentRow<WorkflowFormat>('Recording format', [
        { value: 'readable', label: 'Readable' },
        { value: 'compact', label: 'Compact' },
      ], () => this._config.format, (v) => this._patch({ format: v })),
      this._segmentRow<WorkflowSaveMode>('Save to', [
        { value: 'download', label: 'Downloads' },
        { value: 'picker', label: 'Choose location…' },
      ], () => this._config.saveMode, (v) => this._patch({ saveMode: v })),
      this._shortcutRow(),
      this._segmentRow('Replay speed', WORKFLOW_REPLAY_SPEEDS.map((s) => ({
        value: s,
        label: s === 0 ? 'Instant' : `${s}×`,
      })), () => this._config.replaySpeed, (v) => this._patch({ replaySpeed: v })),
      this._segmentRow('Countdown', [
        { value: 0, label: 'Off' },
        { value: 3, label: '3s' },
      ], () => this._config.countdownSeconds, (v) => this._patch({ countdownSeconds: v })),
      this._captureRow(),
      this._toggleRow('Loop replay', () => this._config.loop, (v) => this._patch({ loop: v })),
    ]);

    const reset = el('button', {
      className: 'olv-wfc-reset',
      text: 'Reset to defaults',
      title: 'Restore the shipped recorder settings',
    });
    reset.addEventListener('click', () => this._apply(DEFAULT_WORKFLOW_CONFIG));
    const footer = el('div', { className: 'olv-wfc-footer' }, [
      el('span', { className: 'olv-wfc-hint', text: 'Esc to close' }),
      reset,
    ]);

    this._card = el('div', { className: 'olv-wfc-card' }, [header, body, footer]);
    this._backdrop = el('div', { className: 'olv-wfc-backdrop' });
    this.element = el('div', { className: 'olv-wfc olv-hidden' }, [this._backdrop, this._card]);

    this._backdrop.addEventListener('click', () => this.close());
    this._card.addEventListener('click', (e) => e.stopPropagation());
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (this._capturingShortcut) this._endShortcutCapture();
        else this.close();
      }
    });
  }

  /** Register the change callback — fired on every edit with the full config. */
  onChange(cb: (config: WorkflowRecorderConfig) => void): void {
    this._onChange = cb;
  }

  /** Seed the panel with the host's current config (no emit). */
  setConfig(config: WorkflowRecorderConfig): void {
    this._config = config;
    for (const sync of this._syncers) sync();
  }

  /** Show the panel. */
  open(): void {
    this._open = true;
    this.element.classList.remove('olv-hidden');
  }

  /** Hide the panel. */
  close(): void {
    this._endShortcutCapture();
    this._open = false;
    this.element.classList.add('olv-hidden');
  }

  /** Whether the panel is currently open. */
  get isOpen(): boolean {
    return this._open;
  }

  // ── control builders ─────────────────────────────────────────────

  private _patch(part: Partial<WorkflowRecorderConfig>): void {
    this._apply({ ...this._config, ...part });
  }

  private _apply(config: WorkflowRecorderConfig): void {
    this._config = config;
    for (const sync of this._syncers) sync();
    this._onChange?.(this._config);
  }

  private _row(label: string, control: HTMLElement): HTMLElement {
    return el('div', { className: 'olv-wfc-row' }, [
      el('span', { className: 'olv-wfc-label', text: label }),
      control,
    ]);
  }

  /** A segmented (single-choice) control. */
  private _segmentRow<T>(
    label: string,
    segments: ReadonlyArray<Segment<T>>,
    get: () => T,
    set: (value: T) => void,
  ): HTMLElement {
    const group = el('div', { className: 'olv-wfc-seg' });
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const buttons = segments.map((s) => {
      const b = el('button', { className: 'olv-wfc-seg-btn', text: s.label });
      b.addEventListener('click', () => {
        b.blur();
        set(s.value);
      });
      return { b, value: s.value };
    });
    group.append(...buttons.map((x) => x.b));
    const sync = (): void => {
      const cur = get();
      for (const { b, value } of buttons) {
        const on = value === cur;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    };
    this._syncers.push(sync);
    sync();
    return this._row(label, group);
  }

  /** A single checkbox toggle. */
  private _toggleRow(label: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const input = el('input', { className: 'olv-wfc-check' });
    input.type = 'checkbox';
    input.addEventListener('change', () => set(input.checked));
    const sync = (): void => {
      input.checked = get();
    };
    this._syncers.push(sync);
    sync();
    return this._row(label, input);
  }

  /** The three capture-scope checkboxes. */
  private _captureRow(): HTMLElement {
    const families: Array<['camera' | 'theme' | 'tools', string]> = [
      ['camera', 'Camera'],
      ['theme', 'Theme'],
      ['tools', 'Tools'],
    ];
    const group = el('div', { className: 'olv-wfc-capture' });
    for (const [key, name] of families) {
      const input = el('input', { className: 'olv-wfc-check' });
      input.type = 'checkbox';
      input.addEventListener('change', () => {
        this._patch({ capture: { ...this._config.capture, [key]: input.checked } });
      });
      const sync = (): void => {
        input.checked = this._config.capture[key];
      };
      this._syncers.push(sync);
      sync();
      group.append(el('label', { className: 'olv-wfc-capture-item' }, [input, el('span', { text: name })]));
    }
    return this._row('Capture', group);
  }

  /** The live key-capture shortcut field plus an "Off" control. */
  private _shortcutRow(): HTMLElement {
    this._shortcutBtn = el('button', { className: 'olv-wfc-shortcut' });
    this._shortcutBtn.addEventListener('click', () => {
      if (this._capturingShortcut) this._endShortcutCapture();
      else this._beginShortcutCapture();
    });
    const off = el('button', { className: 'olv-wfc-shortcut-off', text: 'Off', title: 'No keyboard shortcut' });
    off.addEventListener('click', () => {
      off.blur();
      this._endShortcutCapture();
      this._patch({ shortcut: '' });
    });
    const sync = (): void => {
      if (!this._capturingShortcut) {
        this._shortcutBtn.textContent = formatShortcutLabel(this._config.shortcut, IS_MAC);
        this._shortcutBtn.classList.remove('is-capturing');
      }
    };
    this._syncers.push(sync);
    sync();
    const wrap = el('div', { className: 'olv-wfc-shortcut-wrap' }, [this._shortcutBtn, off]);
    return this._row('Start / stop key', wrap);
  }

  private _beginShortcutCapture(): void {
    this._capturingShortcut = true;
    this._shortcutBtn.textContent = 'Press a combo…';
    this._shortcutBtn.classList.add('is-capturing');
    window.addEventListener('keydown', this._onShortcutKey, true);
  }

  private _endShortcutCapture(): void {
    if (!this._capturingShortcut) return;
    this._capturingShortcut = false;
    window.removeEventListener('keydown', this._onShortcutKey, true);
    this._shortcutBtn.textContent = formatShortcutLabel(this._config.shortcut, IS_MAC);
    this._shortcutBtn.classList.remove('is-capturing');
  }

  private readonly _onShortcutKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this._endShortcutCapture();
      return;
    }
    const chord = chordFromEvent(e);
    if (chord === null) return; // wait for a real Cmd/Ctrl/Alt combination
    e.preventDefault();
    e.stopPropagation();
    this._capturingShortcut = false;
    window.removeEventListener('keydown', this._onShortcutKey, true);
    this._patch({ shortcut: chord });
  };
}
