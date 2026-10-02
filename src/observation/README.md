# src/observation

The Observatory observation kernel (`docs/observatory/SPEC.md`).

This layer is pure: no DOM, `three` or `ui/` imports (OB-INT-01). It is
registered in `LAYERS` in `scripts/lint-layer-boundaries.mjs`.

## Live

The Observatory preview runs this kernel from the Analysis menu. Station
suggestion (`stationSuggestion.ts`) is part of that run:

- `src/app/observatoryFromCloud.ts` calls `planStations` for a loaded cloud.
- `src/ui/observatory/observatoryPanel.ts` lists the suggested stations in the
  Planning section.
- `src/render/ObservatoryStationMarkers.ts` draws a ring for each one, using
  the label defined in `stationSuggestion.ts`.
- `src/export/observatoryPackage.ts` writes them into the exported package.
- `src/science/methodRegistry.ts` registers the method.

`docs/validation/capability-manifest.json` lists station suggestion as a
preview capability.

## Staged

- `src/render/observation/ObservationPointOverlay.ts`, the per-point overlay,
  is registered unreachable in `docs/validation/unreachable-modules.json` and
  is hidden in the capability manifest.
- The live runner builds no strength maps. Coverage gain reads two helpers
  from `strength.ts`; the per-point strength colours belong to the staged
  overlay.
- `session.ts` is registered unreachable.
- `ReachabilityProvider` is an interface with no implementation, so suggested
  stations are not checked for reachability.
