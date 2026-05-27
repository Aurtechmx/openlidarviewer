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

/** The five v0.3.3 report templates. */
export type ReportTemplateId =
  | 'engineering-inspection'
  | 'qa-validation'
  | 'terrain-review'
  | 'survey-summary'
  | 'technical-documentation';

/** Which sections a template wants, in render order. */
export type ReportSectionId =
  | 'cover'
  | 'dataset-summary'
  | 'visuals'
  | 'annotations'
  | 'measurements'
  | 'technical-notes'
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

/** One measurement as the report section renders it. */
export interface ReportMeasurementRow {
  readonly name: string;
  readonly kind: string;
  /** Pre-formatted numeric value with units (e.g. "15.25 m"). */
  readonly value: string;
  readonly pointCount: number;
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
}

/** Output — what the engine returns. */
export interface ReportResult {
  readonly blob: Blob;
  readonly mimeType: 'application/pdf';
  readonly pages: number;
  readonly templateId: ReportTemplateId;
}

/**
 * The pure section contract — each section knows what it needs from the
 * inputs and produces zero-or-more "render commands" the renderer
 * consumes. v0.3.3 wires the renderer to the inputs directly; a
 * command-object indirection is intentionally deferred.
 */
export interface ReportTemplate {
  readonly id: ReportTemplateId;
  readonly label: string;
  readonly description: string;
  /** Sections this template renders, in order. */
  readonly sections: readonly ReportSectionId[];
}
