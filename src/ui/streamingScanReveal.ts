/**
 * streamingScanReveal.ts
 *
 * The chrome a streaming scan reveals once it has attached: the tool dock, the
 * inspector, the navigation bar, and the `olv-has-scan` body class.
 *
 * This exists because the block was written out longhand in the COPC attach
 * path and then not written at all in the EPT one. The result was a loaded EPT
 * scan with panels, a colour legend and a nav bar, and no dock — so no measure,
 * no inspect, no probe, no annotate, and no way to close the scan. Everything
 * looked attached because most of it was.
 *
 * A second format copying a thirteen-line reveal by hand is how that happens.
 * One function, called from both, is how it stops: adding a third streaming
 * format is a call, not a transcription.
 *
 * The parameter is structural rather than the concrete ToolDock / Inspector /
 * NavBar types, which keeps this module free of the constructors and lets a
 * test assert the calls without building any of them.
 */

/** The dock surface this reveal touches. */
export interface RevealDock {
  setEmpty(empty: boolean): void;
  setMeasureEnabled(enabled: boolean): void;
  setAnnotateEnabled(enabled: boolean): void;
  setInspectEnabled(enabled: boolean): void;
  setProbeEnabled(enabled: boolean): void;
  setCloseEnabled(enabled: boolean): void;
  setBackend(backend: 'webgpu' | 'webgl2'): void;
}

/** The inspector surface this reveal touches. */
export interface RevealInspector {
  setEmpty(empty: boolean): void;
}

/** The navigation bar surface this reveal touches. */
export interface RevealNavBar {
  readonly element: { classList: { remove(token: string): void } };
  setMode(mode: 'orbit'): void;
  flashHelp(): void;
}

export interface StreamingScanReveal {
  dock: RevealDock;
  inspector: RevealInspector;
  navBar: RevealNavBar;
  /** The renderer backend, shown on the dock indicator. */
  backend: 'webgpu' | 'webgl2';
  /** `document.body` in the app; any element with a class list in a test. */
  body: { classList: { add(token: string): void } };
}

/**
 * Reveal the scan-dependent chrome for a streaming cloud.
 *
 * Measure, annotate, inspect, probe and close all work on a streaming scan,
 * COPC and EPT alike: each resident node keeps its full decoded per-point
 * attributes. So every tool is enabled here, not a subset per format.
 */
export function revealStreamingScanChrome(reveal: StreamingScanReveal): void {
  const { dock, inspector, navBar, backend, body } = reveal;

  // The dock and inspector start hidden through the empty state so the tools
  // do not crowd the primary call to action on a phone.
  dock.setEmpty(false);
  inspector.setEmpty(false);

  dock.setMeasureEnabled(true);
  dock.setAnnotateEnabled(true);
  dock.setInspectEnabled(true);
  dock.setProbeEnabled(true);
  dock.setCloseEnabled(true);
  dock.setBackend(backend);

  navBar.element.classList.remove('olv-hidden');
  navBar.setMode('orbit');
  navBar.flashHelp();

  body.classList.add('olv-has-scan');
}
