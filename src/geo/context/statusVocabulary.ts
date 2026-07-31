/**
 * statusVocabulary.ts
 *
 * The single source of every user-facing Context View status string. Context
 * View places scans on a 2D world map, and every way it can refuse — unknown
 * CRS, unknown datum, local coordinates, missing transform — must be explained
 * in the same calm, honest voice from one place. Scattering these strings
 * across the eligibility logic, the consent prompt, and the UI would let two
 * surfaces describe the same refusal differently, or let a refusal ship with
 * no explanation at all.
 *
 * The strings state what is missing and what that means; they never speculate
 * about what the coordinates "probably" are. Pure data, no logic.
 */

/** Every Context View status string, frozen so no caller can mutate the vocabulary. */
export const CONTEXT_STATUS = Object.freeze({
  /** Eligibility refusal: the scan declares no CRS at all. */
  crsUnknown:
    'This scan carries no coordinate reference system, so it cannot be placed on a world map.',
  /** Eligibility refusal: a CRS exists but its horizontal datum is not identified. */
  datumUnknown:
    'The horizontal datum of this scan is not identified, so its position on a world map cannot be trusted.',
  /** Eligibility refusal: coordinates are local / engineering / unreferenced. */
  localCoordinates:
    'This scan uses local or unreferenced coordinates that do not correspond to any place on Earth.',
  /** Eligibility refusal: no transform to WGS84 longitude/latitude is available. */
  transformUnavailable:
    'No transform to WGS84 longitude/latitude is available for this scan, so it cannot be projected onto the map.',
  /** Eligibility refusal: the layer's bounds are not finite numbers. */
  boundsNotFinite:
    'The spatial bounds of this scan are not finite, so a map footprint cannot be computed.',
  /** Consent prompt shown before any remote tile request is ever made. */
  consentUnasked:
    'Showing a world basemap requires downloading map tiles from a remote server. No network request has been made. Allow tile downloads for this session?',
  /** Shown after the user declines remote tiles. */
  consentDenied:
    'Remote map tiles are disabled. The context view will show scan footprints without a basemap.',
  /** Attribution note shown once tiles are permitted. */
  consentGranted:
    'Map tiles are downloaded from the selected provider and remain subject to its attribution and usage terms.',
  /** Label for the no-network fallback mode. */
  offlineMode: 'Offline context view: footprints only, no basemap.',
} as const);

/** A key into {@link CONTEXT_STATUS}. */
export type ContextStatusKey = keyof typeof CONTEXT_STATUS;

/** One of the vocabulary strings. */
export type ContextStatusText = (typeof CONTEXT_STATUS)[ContextStatusKey];
