/**
 * index.ts
 *
 * The public surface of the Context View core: pure, Node-testable models for
 * placing loaded scans on a 2D world map. Everything here is data + decisions —
 * eligibility, footprints, camera placement, consent, provider descriptors,
 * and the status vocabulary. No fetching, no DOM, no three.js, no proj4;
 * reprojection is always injected by the caller.
 */

export {
  CONTEXT_STATUS,
  type ContextStatusKey,
  type ContextStatusText,
} from './statusVocabulary';

export {
  decideContextEligibility,
  type ContextLayerFacts,
  type ContextEligible,
  type ContextIneligible,
  type ContextEligibilityDecision,
} from './contextEligibility';

export {
  buildContextFootprint,
  type FootprintBounds,
  type LonLatTransform,
  type ContextFootprint,
  type FootprintRefusal,
  type FootprintResult,
} from './footprintModel';

export {
  mapCameraToContext,
  type ContextCameraPlacement,
  type ContextCameraRefusal,
  type ContextCameraResult,
} from './cameraModel';

export {
  createConsentState,
  parseContextConsent,
  type ContextConsent,
  type ConsentState,
} from './consent';

export {
  NULL_PROVIDER,
  OSM_PROVIDER,
  type ContextTileProvider,
  type OfflineProvider,
} from './providerInterface';
