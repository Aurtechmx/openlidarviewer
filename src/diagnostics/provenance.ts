/**
 * provenance.ts
 *
 * Heuristic capture-type classifier. Reads a small bundle of cheap signals
 * from a loaded scan (file format, point density, footprint geometry, LAS
 * VLR sensor/software strings when present) and returns a best-guess
 * capture type plus a literature-derived expected-accuracy ribbon.
 *
 * The classifier is intentionally honest about its uncertainty:
 *
 *   - It returns `confidence` ∈ ['low', 'medium', 'high'] so the UI can
 *     hedge appropriately.
 *   - It reports the `signals` that drove the verdict so the user can see
 *     why the viewer thinks what it thinks.
 *   - The accuracy ribbon names the source paper for every quoted number,
 *     preserving the "not survey-grade unless validated" positioning.
 *   - The user can override the detected type — this module exposes a pure
 *     classifier; the UI wires up the override.
 *
 * What this module does NOT do:
 *   - Per-point reliability heatmap — out of scope for this module.
 *   - GCP-distance error model — out of scope for this module.
 *   - Any cloud-data iteration. Everything here is metadata-driven.
 *
 * Sources cited in the literature bounds:
 *   - Luetzenburg 2021 (Nature Scientific Reports) — iPhone-LiDAR
 *     accuracy + range bounds.
 *   - Krausková et al. 2025 (Sensors 25/6141) — iPhone-LiDAR walking-drift
 *     thresholds.
 *   - Furlan & Piazentim 2025 (Discover Geoscience) — iPhone outcrop bounds.
 *   - Jiang 2025 (IET Cyber-Syst, peer-reviewed survey) — SLAM APE bounds.
 *   - Bolcek et al. 2025 (Sensors review) — spaceborne footprint specs.
 *   - Tondo et al. 2023 (Sensors) — iPhone temporal/edge artefacts.
 *   - Lohani & Ghosh 2017 (Springer NASI A) — USGS Base Spec / ALS density.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** The set of capture types the classifier can distinguish. */
export type CaptureType =
  | 'iphone-lidar'      // VCSEL-based handheld phone scan (also Polycam, 3D Scanner App, Scaniverse, SiteScape)
  | 'drone-lidar'       // UAV-mounted ALS (DJI L1, RIEGL, Velodyne-on-UAV)
  | 'terrestrial'       // TLS (FARO, Leica, RIEGL VZ)
  | 'mobile-slam'       // Handheld SLAM scanner (NavVis, GeoSLAM)
  | 'aerial-als'        // Manned-aircraft airborne laser scanning (USGS 3DEP class)
  | 'spaceborne'        // GEDI, ICESat-2, CALIOP
  | 'unknown';

/** The classifier's confidence in its verdict. */
export type Confidence = 'low' | 'medium' | 'high';

/**
 * A single literature-derived bound. Plain prose so the UI can render it
 * verbatim; each one names the source paper so the user (and a reviewer of
 * an exported PDF) can trace the claim.
 */
export interface AccuracyBound {
  readonly label: string;       // 'Expected accuracy'
  readonly value: string;       // '± 1 cm at > 10 cm features, < 2.5 m range'
  readonly source: string;      // 'Luetzenburg 2021 (Nature Sci Reports)'
}

/** The classifier's verdict for a loaded scan. */
export interface ProvenanceFingerprint {
  readonly captureType: CaptureType;
  readonly confidence: Confidence;
  /** Short human-readable label, e.g. "iPhone / handheld LiDAR". */
  readonly label: string;
  /** Why the classifier picked this — surfaced in the UI under "Signals". */
  readonly signals: readonly string[];
  /** Literature-derived accuracy ribbon. */
  readonly bounds: readonly AccuracyBound[];
  /**
   * Honest hedge — every fingerprint surfaces this in the UI:
   * "These are expected values from the cited literature, not guarantees."
   */
  readonly disclaimer: string;
}

/**
 * Signals extracted from the loaded scan. Lightweight — anything the
 * caller already knows after the file is open. The classifier never opens
 * the file itself.
 */
export interface ScanSignals {
  /** Source format token ('laz', 'copc', 'ept', 'ply', 'glb', 'pcd', 'ptx', …). */
  readonly sourceFormat: string;
  /** Total point count (source-declared). */
  readonly pointCount: number;
  /** Bounding box extent in metres — [width, depth, height]. May be unknown. */
  readonly extent?: readonly [number, number, number];
  /** Inferred point density in points per square metre, if computable. */
  readonly densityPerSqM?: number;
  /** LAS VLR `System Identifier` (sensor) string when present. */
  readonly sensorString?: string;
  /** LAS VLR `Generating Software` string when present. */
  readonly softwareString?: string;
  /** Whether the scan was loaded via a streaming source (COPC/EPT). */
  readonly streamingSource?: boolean;
  /**
   * The file's own capture declaration, when its declared source metadata
   * (sensorModel / description / name / datasetType / accuracyClass) states a
   * synthetic / procedural / reconstruction / reference origin. When present,
   * the declaration BECOMES the verdict and the heuristic guess is demoted to
   * a secondary, low-confidence line — the classifier must never assert a
   * physical capture type the file itself contradicts. Quoted verbatim;
   * declared by the file, not verified by OpenLiDARViewer.
   */
  readonly declaredCapture?: {
    /** Which declared field the quoted value comes from, e.g. "sensorModel". */
    readonly field: string;
    /** The declared value, verbatim. */
    readonly value: string;
    /** Pre-built verdict headline (composed in the lazy loader chunk). */
    readonly label: string;
    /** Pre-built declaration signal line with the not-verified disclosure. */
    readonly signal: string;
    /** Pre-built disclaimer for the declared verdict. */
    readonly disclaimer: string;
  };
  /**
   * The scan-shape verdict says this is a compact object or an interior space
   * (`scanShape.nonTerrain`). When true, the classifier must never assert an
   * airborne / aerial / spaceborne capture type from density alone — a temple
   * is not drone LiDAR just because its point density resembles a UAV survey.
   * Direct evidence (software / sensor strings, the file's own declaration)
   * still wins; only the indirect density heuristic is ruled out.
   */
  readonly isNonTerrain?: boolean;
  /**
   * Declared evidence that the instrument stood on the ground, phrased by the
   * signal wiring (`provenanceSignals.declaredGroundInstrument`) and quoted
   * here, e.g. "10 registered scan stations". When present, the INDIRECT
   * heuristics (format bias, density signature) may not assert an airborne /
   * aerial / spaceborne capture type: a mine surveyed from ten tripod
   * stations is not an ALS delivery because 1.9 pts/m² over 1434 ha resembles
   * one. Direct evidence (software / sensor strings, the file's own
   * declaration) is matched before this guard and is unaffected.
   */
  readonly declaredGroundInstrument?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifier
// ─────────────────────────────────────────────────────────────────────────────

const DISCLAIMER =
  'These are expected ranges from the cited literature, not guarantees. ' +
  'Your scan may differ — validate against ground control if survey-grade ' +
  'accuracy is required.';

/** Source string for the USGS Lidar Base Specification (QL floors, RMSEz, NVA). */
const USGS_LBS_SOURCE = 'USGS Lidar Base Specification';

/**
 * The airborne disclaimer carries the viewer's own statement about the figure
 * it reports, so that statement is never attributed to a cited paper.
 */
const AERIAL_DISCLAIMER =
  DISCLAIMER +
  ' The NVA-style figure this viewer reports in the Terrain report comes from ' +
  'internally withheld points (hold-out), not independent checkpoints.';

/**
 * Classify a loaded scan from its metadata signals. Pure function — same
 * inputs always produce the same fingerprint.
 *
 * Decision order is deliberate: explicit software strings beat indirect
 * heuristics (a Polycam export is iPhone-LiDAR even if the density happens
 * to look like something else); format hints win for clearly-tagged
 * streaming sources; numeric signatures are the fallback.
 */
export function classify(signals: ScanSignals): ProvenanceFingerprint {
  // The heuristic chain, with a shape guard: a scan the shape router flagged as
  // a compact object / interior can never be asserted as airborne from density
  // alone. Direct evidence inside `classifyHeuristic` (software / sensor
  // strings) has already won by this point if present. The second guard, over
  // the file's own ground-instrument declarations, sits inside
  // `classifyHeuristic` at the seam where the indirect guesses start.
  const heuristic = ruleOutAerialCapture(
    classifyHeuristic(signals),
    signals.isNonTerrain === true
      ? ['Shape reads as a compact object / interior — airborne capture ruled out by geometry.']
      : [],
  );
  // 0. The file's own declaration outranks every heuristic. When the loader
  //    found a declared synthetic / procedural / reconstruction / reference
  //    statement in the source metadata, the verdict quotes it verbatim and
  //    the heuristic guess is demoted to a secondary, low-confidence signal
  //    line — never asserted as the primary capture type.
  if (signals.declaredCapture) {
    return declaredFingerprint(signals.declaredCapture, heuristic);
  }
  return heuristic;
}

/** Airborne capture types the ground guards rule out. */
const AERIAL_CAPTURE_TYPES: ReadonlySet<CaptureType> = new Set<CaptureType>([
  'drone-lidar',
  'aerial-als',
  'spaceborne',
]);

/**
 * When something rules airborne capture out — the scan reads as a compact
 * object / interior, or the file declares a ground-based instrument set-up —
 * an aerial guess is factually wrong. Demote it to an honest "ground-based,
 * method not determined" verdict: we know it is NOT aerial, but the indirect
 * signal can't say which ground-based method it is, so we don't fabricate
 * TLS/SLAM. Each `reasons` line is appended to the signals so the panel shows
 * what ruled airborne out. An empty `reasons` list, a non-aerial verdict
 * (terrestrial, iPhone, mobile SLAM) and every direct-evidence match pass
 * through unchanged.
 */
function ruleOutAerialCapture(
  fp: ProvenanceFingerprint,
  reasons: readonly string[],
): ProvenanceFingerprint {
  if (reasons.length === 0 || !AERIAL_CAPTURE_TYPES.has(fp.captureType)) return fp;
  return {
    captureType: 'unknown',
    confidence: 'low',
    label: 'Ground-based scan — capture method not determined',
    signals: [...fp.signals, ...reasons],
    bounds: [],
    disclaimer: fp.disclaimer,
  };
}

/**
 * The guard lines for a file that declares a ground-based instrument set-up,
 * or an empty list. Applied to the indirect branches of the heuristic chain
 * only, so a declared instrument identity keeps deciding the verdict.
 */
function declaredGroundReasons(signals: ScanSignals): readonly string[] {
  if (!signals.declaredGroundInstrument) return [];
  return [
    `File declares a ground-based instrument set-up (${signals.declaredGroundInstrument}) — ` +
      'airborne capture ruled out by the file\'s own declarations.',
  ];
}

/** The pre-declaration heuristic chain — unchanged when no metadata declares. */
function classifyHeuristic(signals: ScanSignals): ProvenanceFingerprint {
  // 1. Software-string fingerprints — strongest signal when present.
  const swMatch = matchSoftwareString(signals.softwareString);
  if (swMatch) return swMatch;

  // 2. Sensor-string fingerprints (LAS VLR `System Identifier`, or the
  //    declared sensorVendor + sensorModel a scanner format states).
  const sensorMatch = matchSensorString(signals.sensorString);
  if (sensorMatch) return sensorMatch;

  // Everything below is INDIRECT: a format bias and a density signature are
  // guesses about the file, not statements the file makes. A file that
  // declares a ground-based instrument set-up contradicts an airborne guess,
  // so the guard applies from here down and not to steps 1 and 2.
  const ground = declaredGroundReasons(signals);

  // 3. Format-driven defaults — COPC and EPT carry well-known provenance
  //    biases (USGS 3DEP COPC tiles are airborne ALS by overwhelming
  //    majority, etc.).
  const formatMatch = matchFormat(signals);
  if (formatMatch) return ruleOutAerialCapture(formatMatch, ground);

  // 4. Numeric signatures — point count + density + extent.
  const numericMatch = matchNumeric(signals);
  if (numericMatch) return ruleOutAerialCapture(numericMatch, ground);

  // 5. Honest fallback.
  return {
    captureType: 'unknown',
    confidence: 'low',
    label: 'Unknown capture type',
    signals: [
      `Source format: ${signals.sourceFormat || 'unknown'}`,
      signals.pointCount > 0
        ? `Point count: ${signals.pointCount.toLocaleString()}`
        : 'Point count unknown',
    ],
    bounds: [],
    disclaimer:
      'No capture-type signature recognised. The viewer is showing the ' +
      'data as-is; no accuracy ribbon is available without further metadata.',
  };
}

/**
 * The declared-source verdict: the file's own metadata statement, quoted
 * verbatim, with the heuristic guess demoted to a secondary line at reduced
 * confidence. No literature accuracy ribbon is attached — the cited physical
 * capture-type bounds do not describe a declared synthetic / reference
 * reconstruction, and quoting them would overclaim. The wording itself is
 * pre-built at load time (`diagnostics/declaredCapture.ts`, lazy chunk) so
 * the startup shell only threads it through.
 */
function declaredFingerprint(
  declared: NonNullable<ScanSignals['declaredCapture']>,
  heuristic: ProvenanceFingerprint,
): ProvenanceFingerprint {
  const signals = [declared.signal];
  if (heuristic.captureType !== 'unknown') {
    signals.push(`Heuristic guess (secondary, low confidence): ${heuristic.label}`);
  }
  return {
    captureType: 'unknown',
    confidence: 'high',
    label: declared.label,
    signals,
    bounds: [],
    disclaimer: declared.disclaimer,
  };
}

/**
 * Build a fingerprint for an explicitly-chosen capture type. Used by the
 * Inspector's override dropdown — when the classifier got it wrong, the
 * user picks the correct type and the panel rebuilds with the literature
 * bounds for THAT type, no matter what the metadata signals say.
 *
 * The `signals` row records that this fingerprint came from a user
 * override rather than the classifier so the surfacing stays honest.
 */
export function fingerprintFor(
  captureType: CaptureType,
): ProvenanceFingerprint {
  const override = ['User-overridden capture type'];
  switch (captureType) {
    case 'iphone-lidar':  return phoneLidarFingerprint('high', override);
    case 'drone-lidar':   return droneLidarFingerprint('high', override);
    case 'terrestrial':   return terrestrialFingerprint('high', override);
    case 'mobile-slam':   return mobileSlamFingerprint('high', override);
    case 'aerial-als':    return aerialAlsFingerprint('high', override);
    case 'spaceborne':    return spaceborneFingerprint('high', override);
    case 'unknown':
      return {
        captureType: 'unknown',
        confidence: 'low',
        label: 'Unknown capture type',
        signals: override,
        bounds: [],
        disclaimer:
          'The capture type has been set to "unknown" by user override. ' +
          'No accuracy ribbon is shown.',
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Software-string fingerprints
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_LIDAR_SOFTWARE = [
  'polycam',
  '3d scanner',
  '3dscanner',
  'scaniverse',
  'sitescape',
  'recon-3d',
  'recon3d',
];

const TLS_SOFTWARE = [
  'faro scene',
  'leica cyclone',
  'riegl riscan',
  'z+f laser control',
  // Trimble is already a recognised terrestrial vendor in TLS_SENSORS ('trimble x').
  // Its processing suite belongs here for the same reason the other four do.
  'trimble realworks',
];

const SLAM_SOFTWARE = ['navvis', 'geoslam', 'lixel', 'emesent', 'kaarta'];

/**
 * Lower-case a vendor string and flatten every run of non-alphanumerics to one
 * space, so a token written with spaces matches however the producer separated
 * the words. Writers punctuate these freely: "Trimble-RealWorks-8.1",
 * "FARO_SCENE", "Leica.Cyclone". Matching the raw string would find only the
 * spaced spelling and miss the rest, which is what let a Trimble RealWorks scan
 * fall through the terrestrial tokens and be classified from density instead.
 */
function normaliseVendorString(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Production suites that only appear on manned-aircraft deliveries: the
 * TerraSolid family and GeoCue drive the classification step of most
 * national programmes, and LasMonkey is the tiling/QC tool the USGS 3DEP
 * contractors write into `generating_software`. LAStools is deliberately
 * absent; it processes everything from phone scans to ALS.
 */
const AERIAL_ALS_SOFTWARE = ['lasmonkey', 'terrascan', 'terrasolid', 'geocue'];

function matchSoftwareString(sw: string | undefined): ProvenanceFingerprint | null {
  if (!sw) return null;
  const lower = normaliseVendorString(sw);

  for (const tag of AERIAL_ALS_SOFTWARE) {
    if (lower.includes(tag)) {
      return aerialAlsFingerprint('high', [`Software: ${sw}`]);
    }
  }
  for (const tag of PHONE_LIDAR_SOFTWARE) {
    if (lower.includes(tag)) {
      return phoneLidarFingerprint('high', [`Software: ${sw}`]);
    }
  }
  for (const tag of TLS_SOFTWARE) {
    if (lower.includes(tag)) {
      return terrestrialFingerprint('high', [`Software: ${sw}`]);
    }
  }
  for (const tag of SLAM_SOFTWARE) {
    if (lower.includes(tag)) {
      return mobileSlamFingerprint('high', [`Software: ${sw}`]);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sensor-string fingerprints
// ─────────────────────────────────────────────────────────────────────────────

const PHONE_LIDAR_SENSORS = ['iphone', 'ipad', 'ios', 'arkit', 'vcsel'];
/**
 * Airborne instruments, plus the 3DEP contractors who write their company
 * name into `system_identifier` (Quantum Spatial/NV5 do on every Rogue tile).
 * Checked before the TLS list so 'leica als' is not swallowed by 'leica'.
 */
const AERIAL_ALS_SENSORS = ['quantum spatial', 'nv5', 'optech', 'leica als', 'riegl vq', 'riegl lms'];
const TLS_SENSORS = ['faro focus', 'leica', 'riegl vz', 'trimble x'];
const DRONE_LIDAR_SENSORS = ['velodyne', 'dji l1', 'dji l2', 'riegl mini', 'phoenix'];
const SPACEBORNE_SENSORS = ['gedi', 'icesat', 'atlas', 'calipso', 'atlid'];

function matchSensorString(sensor: string | undefined): ProvenanceFingerprint | null {
  if (!sensor) return null;
  const lower = normaliseVendorString(sensor);

  for (const tag of AERIAL_ALS_SENSORS) {
    if (lower.includes(tag)) {
      return aerialAlsFingerprint('high', [`Sensor: ${sensor}`]);
    }
  }
  for (const tag of PHONE_LIDAR_SENSORS) {
    if (lower.includes(tag)) {
      return phoneLidarFingerprint('high', [`Sensor: ${sensor}`]);
    }
  }
  for (const tag of TLS_SENSORS) {
    if (lower.includes(tag)) {
      return terrestrialFingerprint('high', [`Sensor: ${sensor}`]);
    }
  }
  for (const tag of DRONE_LIDAR_SENSORS) {
    if (lower.includes(tag)) {
      return droneLidarFingerprint('high', [`Sensor: ${sensor}`]);
    }
  }
  for (const tag of SPACEBORNE_SENSORS) {
    if (lower.includes(tag)) {
      return spaceborneFingerprint('high', [`Sensor: ${sensor}`]);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Format-driven fingerprints
// ─────────────────────────────────────────────────────────────────────────────

function matchFormat(signals: ScanSignals): ProvenanceFingerprint | null {
  const fmt = signals.sourceFormat.toLowerCase();

  // COPC + EPT are overwhelmingly airborne ALS in the wild — USGS 3DEP,
  // OpenTopography, national mapping agencies. Sensor strings absent
  // because most COPC writers strip the VLR.
  if (fmt === 'copc' || fmt === 'ept') {
    return aerialAlsFingerprint('medium', [
      `Streaming format: ${fmt.toUpperCase()}`,
      'Streaming sources are typically airborne ALS deliveries',
    ]);
  }

  // PLY / OBJ / GLB / GLTF from consumer apps are the iPhone-LiDAR
  // fingerprint when no other signal points elsewhere.
  if (fmt === 'glb' || fmt === 'gltf' || fmt === 'obj') {
    return phoneLidarFingerprint('medium', [
      `Source format: ${fmt.toUpperCase()} (typical phone-LiDAR export)`,
    ]);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Numeric fingerprints (density-driven)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The most a phone's VCSEL flash pattern lays down, in points per square metre.
 * Luetzenburg 2021 measures 7,225 pts/m² at 25 cm, its closest working range,
 * falling to 150 pts/m² at 2.5 m. Density above this at station scale is a
 * ranging scanner rather than a phone.
 */
const PHONE_LIDAR_MAX_DENSITY_PER_SQM = 7225;

/**
 * Footprint at which a dense cloud reads as a manned-aircraft tile rather
 * than a UAV mapping file: half a standard 1 km² USGS 3DEP tile. Drone
 * files in this repo's fixtures and the Ruzgienė 2025 sites are ≤ 10 ha.
 */
const PROJECT_TILE_MIN_AREA_SQM = 500_000;

function matchNumeric(signals: ScanSignals): ProvenanceFingerprint | null {
  // High density on a small extent is the iPhone-LiDAR signature. Luetzenburg
  // 2021 reports 7,225 pts/m² at 25 cm down to 150 pts/m² at 2.5 m for the
  // VCSEL 8×8×3×3 = 576-pts-per-flash pattern.
  if (signals.densityPerSqM !== undefined && signals.extent) {
    const [w, d, _h] = signals.extent;
    const footprintArea = w * d;
    if (
      signals.densityPerSqM > 1000 &&
      footprintArea < 500 // < 500 m² extent — small room, façade, outcrop
    ) {
      // The band above is bounded on both sides. 7,225 pts/m² is the density
      // the same Luetzenburg figures put at the phone's closest working range,
      // so it is the most the flash pattern lays down anywhere; a scan denser
      // than that at station scale is a ranging instrument, and a terrestrial
      // station in a small room is exactly the case that lands here. Without
      // the ceiling the rule contradicted the source it cites, and every dense
      // TLS station under 100 m² read as a phone, because the terrestrial band
      // below starts at a footprint larger than a room.
      //
      // Density alone cannot separate the two inside the band: a phone and a
      // station can both produce 3,000 pts/m². This narrows a rule that was
      // unbounded, it does not claim to resolve the overlap.
      if (signals.densityPerSqM > PHONE_LIDAR_MAX_DENSITY_PER_SQM) {
        return terrestrialFingerprint('medium', [
          `Density: ${signals.densityPerSqM.toFixed(1)} pts/m² over a ${footprintArea.toFixed(0)} m² bounding-box footprint`,
          `Above the ${PHONE_LIDAR_MAX_DENSITY_PER_SQM} pts/m² a phone flash pattern reaches at its closest range`,
        ]);
      }
      return phoneLidarFingerprint('medium', [
        `Density: ${signals.densityPerSqM.toFixed(1)} pts/m² over a ${footprintArea.toFixed(0)} m² bounding-box footprint`,
      ]);
    }

    // ALS density signature — USGS QL2 ≈ 2 pts/m², QL1 ≈ 8 pts/m² (Lohani
    // & Ghosh §6). The bound covers the typical airborne range.
    if (signals.densityPerSqM > 0.5 && signals.densityPerSqM < 50 && footprintArea > 10000) {
      return aerialAlsFingerprint('medium', [
        `Density: ${signals.densityPerSqM.toFixed(1)} pts/m² over a ${(footprintArea / 10000).toFixed(1)} ha bounding-box footprint`,
      ]);
    }

    // UAV / drone ALS — modern low-altitude drone LiDAR (DJI Zenmuse L1/L2,
    // RIEGL miniVUX) maps a site at 100–1000 pts/m²: far denser than manned ALS,
    // yet spread over an open mapping footprint rather than a single TLS station.
    // This band has to come before TLS, or a dense aerial strip falls through to
    // it. Source: Ruzgienė 2025 (Frontiers in Remote Sensing) — drone-LiDAR
    // "100–1000 pts/m² depending on altitude + flight pattern".
    // No upper density cap over a mapping-scale footprint: a very dense
    // low-altitude flight (>2000 pts/m², DJI L2 at low AGL / slow speed) is
    // still drone, not TLS — a terrestrial station cannot lay down uniform
    // high density across thousands of square metres. Very high density over an
    // open footprint is the strongest low-altitude-UAV signature, so it reads
    // 'high'; the literature band (100–1000) stays 'medium'.
    // Above 50 pts/m² density no longer separates manned ALS from UAV: a
    // multi-return forest tile of a QL1 programme lands at 50-80 pts/m² of
    // all returns (this repo's Rogue tiles read 53.7). Footprint does.
    // USGS 3DEP delivers 1 km² tiles (100 ha) and drone mapping files sit
    // well under 50 ha, so a dense cloud at project-tile scale is airborne.
    if (signals.densityPerSqM >= 50 && footprintArea >= PROJECT_TILE_MIN_AREA_SQM) {
      return aerialAlsFingerprint('medium', [
        `Density: ${signals.densityPerSqM.toFixed(1)} pts/m² over a ${(footprintArea / 10000).toFixed(1)} ha bounding-box footprint`,
        'Footprint at project-tile scale (≥ 50 ha): USGS 3DEP tiles are 1 km²',
      ]);
    }
    if (signals.densityPerSqM >= 50 && footprintArea > 2000) {
      const veryDense = signals.densityPerSqM > 1000;
      return droneLidarFingerprint(veryDense ? 'high' : 'medium', [
        `Density: ${signals.densityPerSqM.toFixed(1)} pts/m² over a ${(footprintArea / 10000).toFixed(1)} ha bounding-box mapping footprint`,
      ]);
    }

    // TLS — dense over a SMALL footprint (a single station / façade / outcrop),
    // often millions of points. A dense *large* footprint is drone (above), so
    // this stays bounded to station scale to avoid mislabelling aerial surveys.
    if (
      signals.densityPerSqM > 100 &&
      footprintArea > 100 &&
      footprintArea <= 2000 &&
      signals.pointCount > 1_000_000
    ) {
      return terrestrialFingerprint('medium', [
        `Density: ${signals.densityPerSqM.toFixed(1)} pts/m² with ${signals.pointCount.toLocaleString()} points`,
      ]);
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture-type templates (literature bounds live here)
// ─────────────────────────────────────────────────────────────────────────────

function phoneLidarFingerprint(
  confidence: Confidence,
  signals: readonly string[],
): ProvenanceFingerprint {
  return {
    captureType: 'iphone-lidar',
    confidence,
    label: 'iPhone / handheld LiDAR',
    signals,
    bounds: [
      {
        label: 'Expected accuracy',
        value: '± 1 cm absolute at features > 10 cm, < 2.5 m range',
        source: 'Luetzenburg 2021 (Nature Scientific Reports)',
      },
      {
        label: 'Effective feature size',
        value: '> 10 cm; finer features are below the reliability floor',
        source: 'Luetzenburg 2021',
      },
      {
        label: 'Walking-drift threshold',
        value: '~ 11 cm per 30 m walked; quadratic growth beyond ~ 60 m',
        source: 'Krausková 2025 (Sensors) · Oikawa 2025 via Tamimi',
      },
      {
        label: 'Temporal sampling',
        value: 'True LiDAR rate ~ 15 Hz (60 Hz framerate is interpolated); Nyquist 7.5 Hz',
        source: 'Tondo 2023 (Sensors)',
      },
      {
        label: 'Known failure modes',
        value: 'Edge-bleed near silhouettes; gaps on mirrors / dark / glass surfaces',
        source: 'Tondo 2023 · Kottner 2023',
      },
    ],
    disclaimer: DISCLAIMER,
  };
}

function droneLidarFingerprint(
  confidence: Confidence,
  signals: readonly string[],
): ProvenanceFingerprint {
  return {
    captureType: 'drone-lidar',
    confidence,
    label: 'Drone-mounted LiDAR (UAV ALS)',
    signals,
    bounds: [
      {
        label: 'Typical density',
        value: '100 – 1000 pts/m² depending on altitude + flight pattern',
        source: 'Ruzgienė 2025 (Frontiers in Remote Sensing)',
      },
      {
        label: 'Planimetric tolerance',
        value: 'mean ≤ 1.0 × GSD, max ≤ 1.6 × GSD',
        source: 'Ruzgienė 2025 §4',
      },
      {
        label: 'Elevation tolerance',
        value: 'mean ≤ 1.6 × GSD, max ≤ 2.5 × GSD',
        source: 'Ruzgienė 2025 §4',
      },
    ],
    disclaimer: DISCLAIMER,
  };
}

function terrestrialFingerprint(
  confidence: Confidence,
  signals: readonly string[],
): ProvenanceFingerprint {
  return {
    captureType: 'terrestrial',
    confidence,
    label: 'Terrestrial Laser Scan (TLS)',
    signals,
    bounds: [
      {
        label: 'Typical accuracy',
        value: 'mm-range at < 10 m; degrades with range',
        source: 'Lohani & Ghosh 2017 (Springer NASI A) §3',
      },
      {
        label: 'Typical resolution',
        value: '1 – 5 mm at < 5 m',
        source: 'Fareed 2026 (Remote Sensing review)',
      },
    ],
    disclaimer: DISCLAIMER,
  };
}

function mobileSlamFingerprint(
  confidence: Confidence,
  signals: readonly string[],
): ProvenanceFingerprint {
  return {
    captureType: 'mobile-slam',
    confidence,
    label: 'Mobile SLAM scanner',
    signals,
    bounds: [
      {
        label: 'Indoor handheld APE',
        value: '0.4 – 2 m absolute pose error on typical sequences',
        source: 'Jiang 2025 (IET Cyber-Syst, survey) Table 13',
      },
      {
        label: 'Outdoor mobile APE',
        value: '7 – 22 m on long sequences',
        source: 'Jiang 2025 Table 13',
      },
      {
        label: 'Visible failure modes',
        value: 'Double-walling after failed loop closures; density banding along trajectory',
        source: 'Jiang 2025',
      },
    ],
    disclaimer: DISCLAIMER,
  };
}

function aerialAlsFingerprint(
  confidence: Confidence,
  signals: readonly string[],
): ProvenanceFingerprint {
  return {
    captureType: 'aerial-als',
    confidence,
    label: 'Aerial / airborne LiDAR (ALS)',
    signals,
    bounds: [
      {
        label: 'Typical density (USGS QL2)',
        value: '≥ 2 pts/m² aggregate nominal pulse density',
        source: 'Lohani & Ghosh 2017 §6',
      },
      {
        label: 'Typical density (USGS QL1)',
        value: '≥ 8 pts/m² aggregate nominal pulse density',
        source: 'Lohani & Ghosh 2017 §6',
      },
      {
        label: 'Vertical accuracy (RMSEz)',
        value: 'RMSEz ≤ 10 cm required (NVA ≤ 19.6 cm) for QL1 and QL2 deliveries',
        source: `${USGS_LBS_SOURCE}; Lohani & Ghosh 2017 §6`,
      },
      {
        label: 'NVA formula',
        value: 'NVA = 1.96 × RMSEz (non-vegetated, normal distribution)',
        source: USGS_LBS_SOURCE,
      },
    ],
    disclaimer: AERIAL_DISCLAIMER,
  };
}

function spaceborneFingerprint(
  confidence: Confidence,
  signals: readonly string[],
): ProvenanceFingerprint {
  return {
    captureType: 'spaceborne',
    confidence,
    label: 'Spaceborne LiDAR',
    signals,
    bounds: [
      {
        label: 'GEDI footprint',
        value: '25 m diameter, 60 m along-track / 600 m across-track grid',
        source: 'Bolcek 2025 (Sensors review) Table 2',
      },
      {
        label: 'ICESat-2 footprint',
        value: '~ 17 m diameter, photon-counting',
        source: 'Bolcek 2025 Table 2',
      },
      {
        label: 'Effective ground sampling',
        value: 'Sparse by mission design — not point clouds in the usual sense',
        source: 'Bolcek 2025 §4',
      },
    ],
    disclaimer: DISCLAIMER,
  };
}
