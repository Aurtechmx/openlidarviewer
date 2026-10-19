/**
 * routeUnitFrame.ts — the unit facts scan-type routing reads from the resolved frame.
 *
 * Space and object metrics scale the vertical axis by the vertical unit, which a
 * compound CRS states separately, and fall back to the horizontal factor when
 * none is declared. A vertical unit that IS declared but cannot be read is a
 * different case: the horizontal factor is not evidence about Z. The metrics
 * then run as for an unconfirmed unit, in source units and labelled so, rather
 * than printing metres that nothing established.
 */

import { verticalMetresPerUnit, type SpatialContext } from '../geo/SpatialContext';
import type { ScanRouteFramePort } from './scanRouteCoordinator';

export function routeUnitFrame(
  context: () => SpatialContext,
): Pick<ScanRouteFramePort, 'linearUnitToMetres' | 'verticalUnitToMetres' | 'linearUnitKnown'> {
  return {
    linearUnitToMetres: () => context().linearUnitToMetres,
    verticalUnitToMetres: () => {
      const c = context();
      return verticalMetresPerUnit(c, 'horizontal') ?? c.linearUnitToMetres;
    },
    linearUnitKnown: () => {
      const c = context();
      return c.linearUnitKnown && c.verticalScaleState !== 'invalid';
    },
  };
}
