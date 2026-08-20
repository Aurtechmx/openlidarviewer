/**
 * headerControls.ts — the top bar's right-cluster controls.
 *
 * The theme toggle cycles Dark, Light and High-contrast; back-to-centre
 * performs the same reset the navigation keybinding does, for the case where
 * no key is available; the performance control is the Speed ↔ Quality master
 * dial. All mount left of the GitHub link, and all are no-ops in embed mode,
 * where there is no top bar to mount into.
 */
import { RecenterButton } from './RecenterButton';
import { ThemeToggle } from './ThemeToggle';
import { QualityControl } from './qualityControl';
import { readQualityPreference, writeQualityPreference } from './qualityPreferenceStore';
import type { ThemeName } from './themes';
import { applyQualitySettings, type QualityRenderHost } from '../render/quality/applyQualitySettings';
import type { QualityDevice, QualitySettings } from '../render/quality/qualityPolicy';
import type { StreamingQuality } from '../render/streaming/streamingBudget';

/** The mount surface these controls need, satisfied by `Stage`. */
export interface HeaderControlHost {
  mountHeaderControl(element: HTMLElement): boolean;
}

export interface HeaderControlOptions {
  initialTheme: ThemeName;
  onThemeChange: (name: ThemeName) => void;
  /** Return the camera to the loaded scan. */
  onRecenter: () => void;
}

/**
 * Build and mount the header controls. Returns the theme toggle so the caller
 * can keep driving it, which is what the theme persistence path does.
 */
export function mountHeaderControls(
  host: HeaderControlHost,
  options: HeaderControlOptions,
): ThemeToggle {
  const theme = new ThemeToggle({
    initial: options.initialTheme,
    onChange: options.onThemeChange,
  });
  host.mountHeaderControl(theme.element);
  host.mountHeaderControl(new RecenterButton(options.onRecenter).element);
  return theme;
}

/** What the shell binds the performance control to. */
export interface QualityControlDeps {
  /** The renderer. A thunk because the Viewer arrives from a lazy chunk. */
  getViewer: () => QualityRenderHost;
  /** The device facts the automatic position is derived from. */
  device: () => QualityDevice;
  /** The shell's current streaming preset, so the panel can reflect a change made elsewhere. */
  getStreamingQuality: () => StreamingQuality;
  /**
   * The resolved preset, pushed back at the shell. The scheduler is
   * constructed with this value, so a preset chosen with no cloud open still
   * governs the next streaming open.
   */
  onStreamingQuality: (quality: StreamingQuality) => void;
  /**
   * A user-initiated change landed. The shell re-syncs the Inspector's
   * rendering controls and persists its own preferences here; it is NOT called
   * for the apply that happens at construction, which would otherwise write
   * boot defaults over preferences that have not been read back yet.
   */
  onUserChange: () => void;
}

/**
 * Mount the Speed ↔ Quality control and apply the stored (or automatic)
 * position immediately. Returns the control so the caller can re-resolve it
 * against a device fact that settles later.
 */
export function mountQualityControl(
  host: HeaderControlHost,
  deps: QualityControlDeps,
): QualityControl {
  const control = new QualityControl({
    device: deps.device(),
    preference: readQualityPreference(),
    liveStreamingQuality: deps.getStreamingQuality,
    onApply: (settings: QualitySettings, userInitiated: boolean) => {
      applyQualitySettings(deps.getViewer(), settings, deps.device().isMobile);
      deps.onStreamingQuality(settings.streamingQuality);
      if (userInitiated) deps.onUserChange();
    },
    onPersist: writeQualityPreference,
  });
  host.mountHeaderControl(control.element);
  return control;
}
