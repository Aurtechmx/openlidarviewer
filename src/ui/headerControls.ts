/**
 * headerControls.ts — the top bar's right-cluster controls.
 *
 * The theme toggle cycles Dark, Light and High-contrast; back-to-centre
 * performs the same reset the navigation keybinding does, for the case where
 * no key is available. Both mount left of the GitHub link, and both are no-ops
 * in embed mode, where there is no top bar to mount into.
 */
import { RecenterButton } from './RecenterButton';
import { ThemeToggle } from './ThemeToggle';
import type { ThemeName } from './themes';

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
