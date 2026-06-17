/**
 * report/types.ts
 *
 * Type contracts for the PDF Report Engine. All types are pure — the
 * pdf-lib dependency only enters the actual renderer module
 * (`ReportPdfRenderer.ts`), keeping the public surface tree-shakeable.
 *
 * The engine model: a "report" is a typed `ReportData` object built by
 * `ReportAssetComposer` from the live viewer state, then handed to
 * `ReportPdfRenderer` for the final PDF emission. Sections are pure data
 * — the renderer's only job is to lay them out on pages.
 *
 * The section + template catalogue can be extended without changing the
 * renderer surface.
 */

import type { ReportInspectionSummary } from './ReportFindings';

/** The five built-in report templates. */
export type ReportTemplateId =
  | 'engineering-inspection'
  | 'qa-validation'
  | 'terrain-review'
  | 'survey-summary'
  | 'technical-documentation'
  // A user-supplied-threshold acceptance pass/fail sheet for
  // incoming-scan validation. Metadata-only rows in the current release;
  // the cloud-sampled rows (density, void map, NPS, RMSE) wait for the
  // analysis seam.
  | 'scan-acceptance';

/** Which sections a template wants, in render order. */
export type ReportSectionId =
  | 'cover'
  | 'inspection-summary'     // synthesised findings card (density tier, gaps, caveats)
  | 'dataset-summary'
  | 'provenance'             // v0.3.6 — auto-computed capture-type + literature bounds
  | 'visuals'
  | 'annotations'
  | 'measurements'
  | 'technical-notes'
  | 'acceptance-checklist'   // v0.3.6 — pass/fail rows + methods appendix
  | 'footer';

/** Branding inputs — organisation name, optional logo, author/contact. */
export interface ReportBranding {
  /** Organisation or company name (cover + footer). Omit for a clean cover. */
  readonly organisation?: string;
  /** Optional logo as a data URL (PNG / JPEG only). pdf-lib handles both. */
  readonly logoDataUrl?: string;
  /** Author / inspector name (cover). */
  readonly author?: string;
  /**
   * Brand accent colour as a `#rrggbb` string. Defaults to the OpenLiDARViewer
   * accent (`#00b2ff`). Drives the cover stripe, section headers, footer rule.
   */
  readonly accentColor?: string;
  /**
   * visual theme. `light-technical` (default) is a clean white-paper
   * inspection report; `dark-inspection` is a high-contrast dark-page variant
   * for on-screen review; `minimal-engineering` strips chrome (no accent
   * stripe, monochrome rules) for an austere engineering record.
   */
  readonly theme?: 'light-technical' | 'dark-inspection' | 'minimal-engineering';
  /**
   * optional custom footer line. Appended after the standard
   * "OpenLiDARViewer · timestamp" line; useful for confidentiality notices,
   * project codes, or compliance references.
   */
  readonly footerNote?: string;
  /**
   * extra project-metadata rows on the cover page. Each row that's
   * present is drawn below the author / dataset block, providing structured
   * context for archival and audit reports.
   */
  readonly projectMetadata?: {
    readonly client?: string;
    readonly project?: string;
    readonly phase?: string;
    readonly reference?: string;
    readonly date?: string;
  };
}

/** Cover-page inputs supplied at generation time. */
export interface ReportCoverInputs {
  /** Bold report title (e.g. "Drone LiDAR — Survey Summary"). */
  readonly title: string;
  /** Optional sub-title (e.g. project location / phase). */
  readonly subtitle?: string;
  /** Dataset display name (the scan filename). */
  readonly datasetName: string;
  /** Export timestamp — ISO string. */
  readonly exportedAt: string;
}

/** A single PNG export the visuals section embeds. */
export interface ReportVisualAsset {
  /** Pre-rendered PNG blob from the Studio (Height Map / Intensity / etc.). */
  readonly blob: Blob;
  /** Mode label — appears as the figure caption. */
  readonly caption: string;
  /** Pixel dimensions of the source — used for aspect-preserving layout. */
  readonly width: number;
  readonly height: number;
}

/** Dataset summary rows — what the metadata section lists. */
export interface ReportDatasetRow {
  readonly label: string;
  readonly value: string;
}

/** One annotation as the report section renders it (denormalised view). */
export interface ReportAnnotationRow {
  readonly title: string;
  readonly type: string;
  readonly note?: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly createdAt: number;
}

/**
 * v0.3.10 Profile-as-Deliverable — optional per-row block surfaced for
 * `kind === 'profile'`. Carries pre-formatted strings the PDF renderer
 * can lay out as a small civil-deliverable detail block beneath the
 * row's headline. All fields are strings so the renderer never has to
 * format units; that decision lives in `ReportMeasurementSection`.
 *
 * When `details` is absent (loaded from a pre-v0.3.10 session, or
 * computed without samples), the PDF falls back to the headline-only
 * row — the deliverable degrades cleanly, not catastrophically.
 */
export interface ReportProfileDeliverableExtras {
  /** "Horizontal length · Δh · grade" — same shape as the live UI. */
  readonly summary: string;
  /** "0 m · 25 m · 50 m · 75 m · 100 m" — the station chainage list. */
  readonly stations: string;
  /** "Station interval 25 m" — the chosen chainage spacing. */
  readonly stationInterval: string;
  /** "Max +5.2 %, Min −1.8 %, Avg +1.7 %" — slope grade summary. */
  readonly slopeSummary: string;
  /** Optional Δh refinement caveat — surfaces the streaming-resident warning. */
  readonly coverageCaveat?: string;
  /**
   * The cross-section samples (distance along the line, elevation) the renderer
   * draws as a small vector profile chart beneath the text block. Present only
   * when the profile carries at least two finite samples; the renderer
   * self-normalises them, so the units are immaterial.
   */
  readonly chart?: ReadonlyArray<{ readonly distance: number; readonly height: number }>;
}

/** One measurement as the report section renders it. */
export interface ReportMeasurementRow {
  readonly name: string;
  readonly kind: string;
  /** Pre-formatted numeric value with units (e.g. "15.25 m"). */
  readonly value: string;
  readonly pointCount: number;
  /**
   * Optional deliverable-grade detail block. Currently populated for
   * `kind === 'profile'` only. When absent, the row renders as the
   * single headline line. v0.3.10 Profile-as-Deliverable stream.
   */
  readonly profileExtras?: ReportProfileDeliverableExtras;
}

/**
 * v0.3.6 — one row in the Scan Acceptance Checklist.
 *
 * The caller computes pass/fail against user-supplied thresholds before
 * handing the row to the report engine. The viewer reports what was
 * measured; the threshold-vs-pass-fail decision is the user's.
 *
 * No USGS QL1 / QL2 thresholds are baked in — those airborne-specific
 * values would be misapplied to TLS / iPhone / cropped subsets. Each row
 * names its own threshold so a surveyor handing the PDF to a contract
 * dispute has the citations on hand.
 */
export interface ReportAcceptanceRow {
  readonly label: string;        // 'Point count'
  readonly threshold: string;    // '≥ 5,000,000'
  readonly actual: string;       // '12,400,000'
  readonly pass: boolean;
  readonly note?: string;        // 'CRS missing — cannot georeference exports'
}

/**
 * The full inputs the engine takes — everything needed to render a report,
 * cleanly separated from the live Viewer / DOM. Each field is optional so
 * a partial report still works; the renderer renders what's there.
 */
export interface ReportInputs {
  readonly templateId: ReportTemplateId;
  readonly branding: ReportBranding;
  readonly cover: ReportCoverInputs;
  readonly datasetRows: readonly ReportDatasetRow[];
  readonly visuals: readonly ReportVisualAsset[];
  readonly annotations: readonly ReportAnnotationRow[];
  readonly measurements: readonly ReportMeasurementRow[];
  /** Free-form Markdown-ish notes appended to the report. Optional. */
  readonly technicalNotes?: string;
  /**
   * v0.3.6 — pass/fail rows for the Scan Acceptance template. The caller
   * computes pass/fail against user-supplied thresholds before handing
   * the rows to the report engine. Omit when the template doesn't include
   * the `acceptance-checklist` section.
   */
  readonly acceptanceChecks?: readonly ReportAcceptanceRow[];
  /**
   * v0.3.6 — capture-type provenance fingerprint. Lifted directly from
   * the classifier output the Inspector's "Provenance" section also
   * uses. Templates that include the `provenance` section render a
   * label + confidence + signals + literature-cited accuracy bounds.
   * Auto-computed (no user action required) and varies by scan, so
   * even an out-of-the-box export carries content that distinguishes
   * one scan from another.
   *
   * Shape mirrors `ProvenanceFingerprint` in `diagnostics/provenance.ts`,
   * inlined here so the report module stays diagnostics-blind.
   */
  readonly provenance?: ReportProvenanceFingerprint;
  /**
   * Synthesised inspection summary — a headline + scannable findings + the
   * explicit list of what the report does not establish. Built by
   * `buildInspectionSummary` in the composer from the dataset metadata and
   * the provenance fingerprint. Rendered by templates that include the
   * `inspection-summary` section; omitted otherwise.
   */
  readonly summary?: ReportInspectionSummary;
}

/**
 * Capture-type fingerprint for the `provenance` section. Field shapes
 * mirror `ProvenanceFingerprint` in `diagnostics/provenance.ts` exactly
 * — the caller copies the classifier output across the boundary so the
 * report module doesn't need to import diagnostics.
 */
export interface ReportProvenanceFingerprint {
  readonly label: string;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly signals: readonly string[];
  readonly bounds: readonly {
    readonly label: string;
    readonly value: string;
    readonly source: string;
  }[];
  readonly disclaimer: string;
}

/** Output — what the engine returns. */
export interface ReportResult {
  readonly blob: Blob;
  readonly mimeType: 'application/pdf';
  readonly pages: number;
  readonly templateId: ReportTemplateId;
  /**
   * Sections the renderer attempted but caught an error during draw —
   * pdf-lib's per-section try/catch swallows the failure so the rest of
   * the PDF still ships. Empty in the common case. The caller surfaces
   * the names in a toast so the user knows the PDF is partial.
   *
   * Returned values are the section ids the renderer iterated over,
   * matching `ReportTemplate.sections`.
   */
  readonly failedSections: readonly ReportSectionId[];
}

/**
 * The pure section contract — each section knows what it needs from the
 * inputs and produces zero-or-more "render commands" the renderer
 * consumes. The renderer reads the inputs directly; a command-object
 * indirection is intentionally deferred.
 */
export interface ReportTemplate {
  readonly id: ReportTemplateId;
  readonly label: string;
  readonly description: string;
  /** Sections this template renders, in order. */
  readonly sections: readonly ReportSectionId[];
}
