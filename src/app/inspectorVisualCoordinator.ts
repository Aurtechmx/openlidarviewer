/**
 * inspectorVisualCoordinator.ts
 *
 * Keeps the Viewer's visual state and the Inspector's controls in step: the
 * Visuals Studio rails (RGB appearance, EDL, sky, white balance, workflow
 * preset), the rendering sliders, and the one-shot seeding of the streaming
 * filter extents. Every preset here fans out through the Viewer's existing
 * setters and re-projects the surfaces the change touched; nothing renders
 * and no preference is written here, the shell is told a preference changed.
 *
 * The streaming filter seed is a two-state machine owned here: UNSEEDED until
 * a resident extent exists, SEEDED once the Inspector has been handed the
 * elevation and intensity windows, and back to UNSEEDED when the shell says a
 * streaming source opened or closed. Seeding once, not per node, keeps a
 * growing resident range from stomping a window the user set mid-stream.
 */
import {
  getTerrainWorkflowPreset,
  matchTerrainWorkflowPreset,
  type TerrainWorkflowPresetId,
} from '../render/terrainWorkflowPresets';
import { isRgbAppearancePresetId } from '../render/rgbAppearance';
import { isSkyPreset } from '../render/skyPresets';
import type { Viewer } from '../render/Viewer';
import type { Inspector } from '../ui/Inspector';
import type { ColorMode } from '../render/colorModes';

/** What the coordinator reads off the renderer. */
export interface VisualStateSource {
  edlPresetId(): Viewer['edlPresetId'];
  pointSize(): number;
  pointSizeMode(): Viewer['pointSizeMode'];
  skyPresetId(): Viewer['skyPresetId'];
  heightPercentileTrim(): Viewer['heightPercentileTrim'];
  rgbAppearancePresetId(): Viewer['rgbAppearancePresetId'];
  rgbAppearance(): Viewer['rgbAppearance'];
  streamingActive(): boolean;
  edlEnabled(): boolean;
  edlStrength(): number;
  antialiasing(): Viewer['antialiasing'];
  twoFingerTwistEnabled(): boolean;
  splatMode(): Viewer['splatMode'];
  hasStreamingCloud(): boolean;
  elevationExtent(): ReturnType<Viewer['elevationExtent']>;
  intensityExtent(): ReturnType<Viewer['intensityExtent']>;
}

/** What the coordinator sets on the renderer. */
export interface VisualStateSink {
  setEdlPreset: Viewer['setEdlPreset'];
  setPointSize: Viewer['setPointSize'];
  setPointSizeMode: Viewer['setPointSizeMode'];
  setSky: Viewer['setSky'];
  setHeightPercentileTrim: Viewer['setHeightPercentileTrim'];
  applyRgbAppearancePreset: Viewer['applyRgbAppearancePreset'];
  setRgbAppearance: Viewer['setRgbAppearance'];
  setColorMode: Viewer['setColorMode'];
  setStreamingColorMode: Viewer['setStreamingColorMode'];
}

/** The Inspector surfaces the coordinator projects into. */
export interface VisualStateView {
  syncVisuals: Inspector['syncVisuals'];
  setAdvancedWbVisible: Inspector['setAdvancedWbVisible'];
  syncRendering: Inspector['syncRendering'];
  setElevationExtent: Inspector['setElevationExtent'];
  setIntensityExtent: Inspector['setIntensityExtent'];
}

export interface InspectorVisualCoordinatorDeps {
  readonly source: VisualStateSource;
  readonly sink: VisualStateSink;
  readonly view: VisualStateView;
  /** The active scan id, or null; a workflow preset recolours it. */
  readonly activeScanId: () => string | null;
  /** The shell's record of the current colour mode. */
  readonly colorMode: { get(): ColorMode | undefined; set(mode: ColorMode): void };
  /** Re-sync the colour-mode chip after a setter may have changed the mode. */
  readonly afterColorModeChange: () => void;
  /** A visual preference changed; the shell persists it. */
  readonly onPreferenceChanged: () => void;
  readonly warn?: (message: string, err: unknown) => void;
}

export type StreamingFilterSeed = 'unseeded' | 'seeded';

export interface InspectorVisualCoordinator {
  /** Push the renderer's Visuals Studio state into the Inspector rails. */
  syncVisuals(): void;
  /** Push the renderer's rendering knobs into the Inspector sliders. */
  syncRendering(): void;
  /** Seed the streaming filter controls from resident data; true once seeded. */
  seedStreamingFilterExtents(): boolean;
  /** A streaming source opened or closed: the next node seeds again. */
  resetStreamingFilterSeed(): void;
  streamingFilterSeed(): StreamingFilterSeed;
  applyWorkflowPreset(id: TerrainWorkflowPresetId): void;
  /** Ignores an id that is not a known preset. */
  applyRgbAppearancePreset(id: string): void;
  applyEdlPreset(id: Parameters<Viewer['setEdlPreset']>[0]): void;
  /** Ignores an id that is not a known sky. */
  applySky(id: string): void;
  setWhiteBalance(temperature: number, tint: number): void;
  /** A suggested appearance landed (auto balance): apply and re-project. */
  applyRgbAppearance(appearance: Parameters<Viewer['setRgbAppearance']>[0]): void;
}

export function createInspectorVisualCoordinator(deps: InspectorVisualCoordinatorDeps): InspectorVisualCoordinator {
  const { source, sink, view } = deps;
  const warn = deps.warn ?? ((message, err) => console.warn(message, err));
  let seed: StreamingFilterSeed = 'unseeded';

  function syncVisuals(): void {
    // Which preset (if any) the current knobs equal; a hand-tweak of a
    // preset-managed knob reads 'custom'.
    const workflowPresetId =
      matchTerrainWorkflowPreset({
        colorMode: deps.colorMode.get() ?? null,
        edlPresetId: source.edlPresetId(),
        pointSize: source.pointSize(),
        pointSizeMode: source.pointSizeMode(),
        skyPresetId: source.skyPresetId(),
        heightPercentileTrim: source.heightPercentileTrim(),
      }) ?? 'custom';
    const appearance = source.rgbAppearance();
    view.syncVisuals({
      rgbAppearancePresetId: source.rgbAppearancePresetId(),
      edlPresetId: source.edlPresetId(),
      skyPresetId: source.skyPresetId(),
      temperature: appearance.temperature ?? 0,
      tint: appearance.tint ?? 0,
      workflowPresetId,
    });
    // Temperature, Tint and Auto-balance only land on streaming tiles; for a
    // local scan the RGB preset chips cover the use case.
    view.setAdvancedWbVisible(source.streamingActive());
  }

  function syncRendering(): void {
    view.syncRendering({
      pointSize: source.pointSize(),
      edlEnabled: source.edlEnabled(),
      edlStrength: source.edlStrength(),
      pointSizeMode: source.pointSizeMode(),
      antialiasing: source.antialiasing(),
      twoFingerTwistEnabled: source.twoFingerTwistEnabled(),
      splatMode: source.splatMode(),
    });
  }

  return {
    syncVisuals,
    syncRendering,
    seedStreamingFilterExtents() {
      if (seed === 'seeded' || !source.hasStreamingCloud()) return seed === 'seeded';
      const elev = source.elevationExtent();
      const inten = source.intensityExtent();
      // Elevation is header-derived and available at once; intensity needs a
      // resident node. Wait until at least one is present.
      if (!elev && !inten) return false;
      view.setElevationExtent(elev);
      view.setIntensityExtent(inten);
      seed = 'seeded';
      return true;
    },
    resetStreamingFilterSeed() {
      seed = 'unseeded';
    },
    streamingFilterSeed: () => seed,
    applyWorkflowPreset(id) {
      const p = getTerrainWorkflowPreset(id);
      sink.setEdlPreset(p.edlPresetId);
      sink.setPointSize(p.pointSize);
      sink.setPointSizeMode(p.pointSizeMode);
      sink.setSky(p.sky);
      sink.setHeightPercentileTrim(p.heightPercentileTrim);
      // Colour mode is per-cloud and channel-gated: a cloud without the channel
      // throws, so it keeps its colours and the rest of the bundle still lands;
      // the record moves only once the set applied.
      const id0 = deps.activeScanId();
      if (id0) {
        try {
          sink.setColorMode(id0, p.colorMode);
          deps.colorMode.set(p.colorMode);
        } catch (err) {
          warn(`[workflow-preset] colour mode ${p.colorMode} skipped:`, err);
        }
      }
      try {
        sink.setStreamingColorMode(p.colorMode);
      } catch (err) {
        warn('[workflow-preset] streaming colour mode skipped:', err);
      }
      deps.afterColorModeChange();
      syncVisuals();
      syncRendering();
      deps.onPreferenceChanged();
    },
    applyRgbAppearancePreset(id) {
      if (!isRgbAppearancePresetId(id)) return;
      sink.applyRgbAppearancePreset(id);
      // The preset may have flipped the active cloud into RGB mode.
      deps.afterColorModeChange();
      syncVisuals();
      deps.onPreferenceChanged();
    },
    applyEdlPreset(id) {
      sink.setEdlPreset(id);
      syncVisuals();
      syncRendering();
      deps.onPreferenceChanged();
    },
    applySky(id) {
      if (!isSkyPreset(id)) return;
      sink.setSky(id);
      syncVisuals();
      deps.onPreferenceChanged();
    },
    setWhiteBalance(temperature, tint) {
      sink.setRgbAppearance({ ...source.rgbAppearance(), temperature, tint });
      deps.afterColorModeChange();
      syncVisuals();
      deps.onPreferenceChanged();
    },
    applyRgbAppearance(appearance) {
      sink.setRgbAppearance(appearance);
      syncVisuals();
      deps.onPreferenceChanged();
    },
  };
}
