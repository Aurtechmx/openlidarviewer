/**
 * contourDeliverablePdfModel.ts
 *
 * The content model for the premium multipage contour PDF (v0.5.9 spec §20).
 * Pure: it assembles the page-by-page text of the deliverable from provenance,
 * the support/validation numbers, and the PR9 export decision — WITHOUT touching
 * pdf-lib. The pixel render consumes this model; keeping the model pure lets the
 * honesty rules (§20.6/§20.7) be unit-tested without producing a PDF.
 *
 * Honesty rules enforced here:
 *  - a BLOCKED product never yields a polished deliverable (§19.4) — building one
 *    throws; the caller produces a diagnostic report instead;
 *  - an EXPLORATORY product always carries the watermark + badge;
 *  - the geometry role is always disclosed (cartographic shown; analytical
 *    available separately) so a generalized map is never read as exact;
 *  - no "survey-grade / certified / standards compliant / guaranteed accuracy"
 *    wording is asserted — the not-survey-grade note is the only place
 *    "survey-grade" may appear, and only negated.
 */

import { NOT_SURVEY_GRADE_NOTE } from '../export/exportProvenance';
import type { ScientificExportDecision } from '../../export/exportManifest';

export interface ContourPdfProvenance {
  readonly software: string;
  readonly softwareVersion: string;
  readonly gitCommit: string;
  readonly generated: string;
  readonly crs: string;
  readonly verticalDatum: string;
  readonly horizontalUnit: string;
  readonly verticalUnit: string;
  readonly grid: string;
  readonly methodIds: readonly string[];
  readonly sourceHash: string;
}

export interface ContourPdfInput {
  readonly title: string;
  readonly provenance: ContourPdfProvenance;
  readonly support: { readonly measuredPct: number; readonly interpolatedPct: number; readonly unsupportedPct: number };
  readonly validation: { readonly mode: string; readonly rmseM: number | null; readonly sampleSize: number; readonly independentCheckpoints: boolean };
  readonly decision: ScientificExportDecision;
  readonly geometry: { readonly cartographic: boolean; readonly analyticalAvailable: boolean };
  /** Include the optional standards-traceability page (§20.5). */
  readonly standardsTraceability?: boolean;
}

export interface ContourPdfPage {
  readonly title: string;
  readonly lines: readonly string[];
}

export interface ContourPdfModel {
  readonly titleBlock: readonly string[];
  readonly evidenceBadge: string;
  readonly watermark: string | null;
  readonly pages: readonly ContourPdfPage[];
}

const num = (n: number): string => Number.parseFloat(n.toFixed(3)).toString();

/**
 * Build the deliverable model. Throws for a blocked decision (a blocked product
 * must not become a polished deliverable, §19.4).
 */
export function buildContourPdfModel(input: ContourPdfInput): ContourPdfModel {
  if (input.decision.status === 'blocked') {
    throw new Error(
      'Contour PDF: the export decision is blocked — build a diagnostic report, not a polished deliverable.',
    );
  }
  const exploratory = input.decision.status === 'exploratory';
  const evidenceBadge = exploratory ? 'Exploratory' : 'Internal validation only';
  const watermark = exploratory ? input.decision.watermark : null;

  const titleBlock: string[] = [
    input.title,
    `${input.provenance.software} ${input.provenance.softwareVersion}`,
    `Generated ${input.provenance.generated}`,
    `Evidence: ${evidenceBadge}`,
    NOT_SURVEY_GRADE_NOTE,
  ];

  // ── Page 1 — Contour map ────────────────────────────────────────────────
  const geometryNote = input.geometry.cartographic
    ? 'Cartographic (generalized) contours are shown for legibility.' +
      (input.geometry.analyticalAvailable ? ' Exact analytical geometry is available in the GIS export.' : '')
    : 'Analytical (exact) contours are shown.';
  const mapPage: ContourPdfPage = {
    title: 'Contour map',
    lines: [
      geometryNote,
      `Vertical unit: ${input.provenance.verticalUnit}`,
      `Evidence: ${evidenceBadge}`,
      ...(exploratory ? [`Watermarked ${watermark}: ${input.decision.caveats[0] ?? ''}`.trim()] : []),
    ],
  };

  // ── Page 2 — Surface support ────────────────────────────────────────────
  const supportPage: ContourPdfPage = {
    title: 'Surface support',
    lines: [
      `Measured: ${num(input.support.measuredPct)}%`,
      `Interpolated: ${num(input.support.interpolatedPct)}%`,
      `Unsupported: ${num(input.support.unsupportedPct)}%`,
    ],
  };

  // ── Page 3 — Validation ─────────────────────────────────────────────────
  const validationPage: ContourPdfPage = {
    title: 'Validation',
    lines: [
      `Mode: ${input.validation.mode}`,
      `RMSE: ${input.validation.rmseM == null ? '—' : `${num(input.validation.rmseM)} m`}`,
      `Sample size: ${input.validation.sampleSize}`,
      `Independent checkpoints: ${input.validation.independentCheckpoints ? 'yes' : 'none provided'}`,
    ],
  };

  // ── Page 4 — Method and provenance ──────────────────────────────────────
  const provenancePage: ContourPdfPage = {
    title: 'Method and provenance',
    lines: [
      `Source hash: ${input.provenance.sourceHash}`,
      `CRS: ${input.provenance.crs}`,
      `Vertical datum: ${input.provenance.verticalDatum}`,
      `Horizontal unit: ${input.provenance.horizontalUnit}`,
      `Vertical unit: ${input.provenance.verticalUnit}`,
      `Grid: ${input.provenance.grid}`,
      `Methods: ${input.provenance.methodIds.join(', ')}`,
      `Software: ${input.provenance.software} ${input.provenance.softwareVersion}`,
      `Git commit: ${input.provenance.gitCommit}`,
      `Generated: ${input.provenance.generated}`,
    ],
  };

  const pages: ContourPdfPage[] = [mapPage, supportPage, validationPage, provenancePage];

  // ── Optional Page 5 — Standards traceability (§20.5) ────────────────────
  if (input.standardsTraceability) {
    pages.push({
      title: 'Standards traceability',
      lines: [
        'Compared with selected thresholds only — this is not a statement of standards compliance.',
        'Each checked item is marked: tested threshold / not assessed / not applicable / fails tested threshold.',
      ],
    });
  }

  return { titleBlock, evidenceBadge, watermark, pages };
}

const FORBIDDEN = ['certified', 'standards compliant', 'guaranteed accura'];

/**
 * Validate the model against the §20.7 honesty rules. Returns any problems; an
 * empty list means the model is publication-safe.
 */
export function validateContourPdfModel(model: ContourPdfModel): { ok: boolean; problems: string[] } {
  const problems: string[] = [];

  if (model.pages.length < 4) problems.push(`expected at least 4 pages, got ${model.pages.length}`);

  const title = model.titleBlock.join('\n').toLowerCase();
  if (!/generated/.test(title)) problems.push('title block missing the generated timestamp');
  if (!/evidence:/.test(title)) problems.push('title block missing the evidence badge');
  if (!/not survey-grade/.test(title)) problems.push('title block missing the not-survey-grade note');

  const allText = [
    ...model.titleBlock,
    ...model.pages.flatMap((p) => [p.title, ...p.lines]),
  ]
    .join('\n')
    .toLowerCase();

  for (const bad of FORBIDDEN) {
    if (allText.includes(bad)) problems.push(`asserts forbidden wording: "${bad}"`);
  }
  // "survey-grade" may appear ONLY negated (in the not-survey-grade note).
  const surveyGrade = (allText.match(/survey-grade/g) ?? []).length;
  const notSurveyGrade = (allText.match(/not survey-grade/g) ?? []).length;
  if (surveyGrade > notSurveyGrade) problems.push('asserts "survey-grade" outside a negated note');

  // Geometry role must be disclosed on the map page.
  const mapText = (model.pages[0]?.lines ?? []).join(' ').toLowerCase();
  if (!/(analytical|cartographic)/.test(mapText)) problems.push('map page does not disclose the geometry role');

  // Watermark ⇔ exploratory badge.
  const exploratory = /exploratory/.test(model.evidenceBadge.toLowerCase());
  if (exploratory && !model.watermark) problems.push('exploratory model is missing its watermark');
  if (!exploratory && model.watermark) problems.push('non-exploratory model carries a watermark');

  return { ok: problems.length === 0, problems };
}
