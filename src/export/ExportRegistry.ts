/**
 * ExportRegistry.ts
 *
 * Visual Export Studio's name → factory map. The Studio panel asks the
 * registry for the modes available against the current scene; the orchestrator
 * (`renderExport`) asks it for a factory by mode name.
 *
 * The registry is intentionally minimal: register / get / has / list /
 * availableModes / size. A factory cannot be registered twice — duplicate
 * registration is always a bug (dev double-import, stale HMR), never a
 * legitimate "override" — so we throw instead of silently winning-last.
 *
 * Pure — no DOM, no three.js. Factories themselves talk to three.js.
 */

import type {
  ExportContext,
  ExportFactory,
  ExportMode,
  ExportUnavailableReason,
} from './types';

export class ExportRegistry {
  private readonly _byMode = new Map<ExportMode, ExportFactory>();

  /** Register a factory. Throws on duplicate mode. */
  register(factory: ExportFactory): void {
    if (this._byMode.has(factory.mode)) {
      throw new Error(
        `ExportRegistry: mode "${factory.mode}" is already registered`,
      );
    }
    this._byMode.set(factory.mode, factory);
  }

  /** Look up a factory, or `undefined` if the mode is unknown. */
  get(mode: ExportMode): ExportFactory | undefined {
    return this._byMode.get(mode);
  }

  /** Whether a mode has been registered. */
  has(mode: ExportMode): boolean {
    return this._byMode.has(mode);
  }

  /** Every registered factory, in insertion order. */
  list(): ExportFactory[] {
    return [...this._byMode.values()];
  }

  /**
   * The subset of registered modes whose `isAvailable(context)` returns true.
   * The Studio panel uses this to enable / disable buttons on the fly as the
   * loaded cloud changes (e.g. classification disabled for a PLY).
   */
  availableModes(context: ExportContext): ExportFactory[] {
    return this.list().filter((f) => f.isAvailable(context));
  }

  /**
   * Every registered mode that is unavailable for the given context, paired
   * with the reason. Used by the Studio panel to render explicit disabled
   * tooltips ("intensity not present in this cloud") instead of silent gating.
   */
  unavailableModes(context: ExportContext): ExportUnavailableReason[] {
    const out: ExportUnavailableReason[] = [];
    for (const f of this.list()) {
      if (!f.isAvailable(context)) {
        out.push({
          mode: f.mode,
          reason: f.unavailableReason?.(context) ?? 'unavailable on this cloud',
        });
      }
    }
    return out;
  }

  /** Count of registered factories — used by tests and diagnostics. */
  get size(): number {
    return this._byMode.size;
  }
}
