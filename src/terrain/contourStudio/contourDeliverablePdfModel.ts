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
import { reportWords, type ReportWords } from '../export/reportWords';
import { languageInfo } from '../../i18n/languages';
import { ENGLISH, type ExportLocale } from '../../i18n/exportLocale';
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
  /** SHA-256 of the source file, or why none was recorded. */
  readonly sourceSha256: string;
  /** Content hash of the analysis record, which is not the file's. */
  readonly recordHash: string;
}

export interface ContourPdfInput {
  readonly title: string;
  /** The deliverable's own name; when set, the title is written from it in the export language. */
  readonly name?: string;
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
  /** BCP 47 tag of the language the text is in; English (United States) when absent. */
  readonly languageTag?: string;
  /** The document title when the title block has none. */
  readonly fallbackTitle?: string;
}

const num = (n: number): string => Number.parseFloat(n.toFixed(3)).toString();

class Untranslated extends Error {}
const need = (got: string | null, text: string): string => {
  if (got === null) throw new Untranslated(text);
  return got;
};

/**
 * Build the deliverable model. Throws for a blocked decision (a blocked product
 * must not become a polished deliverable, §19.4).
 *
 * Written in `locale` (English when absent). When a text of the input has no
 * translation the whole model is in English and says so: a deliverable is never
 * half translated.
 */
export function buildContourPdfModel(input: ContourPdfInput, locale: ExportLocale = ENGLISH): ContourPdfModel {
  if (input.decision.status === 'blocked') {
    throw new Error(
      'Contour PDF: the export decision is blocked — build a diagnostic report, not a polished deliverable.',
    );
  }
  const words = reportWords(locale);
  try {
    return modelIn(input, words, words.draft);
  } catch (err) {
    if (!(err instanceof Untranslated)) throw err;
    const english = reportWords();
    return modelIn(input, english, english.say('X_languageFallback', { u_name: languageInfo(locale.lang).name }));
  }
}

function modelIn(input: ContourPdfInput, w: ReportWords, language: string | null): ContourPdfModel {
  const p = input.provenance;
  const decision = input.decision;
  if (decision.status === 'blocked') throw new Error('Contour PDF: the export decision is blocked.');
  const tr = (text: string): string => need(w.translate(text), text);
  /** A value this path writes as a word when it is not known; anything else is copied. */
  const known = (text: string, absent: string): string => (text === absent ? tr(text) : text);
  const unit = (text: string): string => need(w.plain ? text : w.word('UNIT', text), text);
  const exploratory = decision.status === 'exploratory';
  const evidenceBadge = w.say(exploratory ? 'PERMIT_exploratory' : 'PERMIT_badge');
  const watermark = exploratory ? (w.plain ? decision.watermark : need(w.word('PERMIT', decision.watermark), decision.watermark)) : null;
  const evidenceLine = w.say('CS_evidence', { u_b: evidenceBadge });
  const software = `${p.software} ${p.softwareVersion}`;

  const titleBlock: string[] = [
    input.name === undefined ? input.title : w.say('CS_title', { u_name: input.name }),
    software,
    w.say('CS_generated', { u_t: p.generated }),
    evidenceLine,
    tr(NOT_SURVEY_GRADE_NOTE),
    ...(language === null ? [] : [w.say('CS_language', { u_l: language })]),
  ];

  // ── Page 1 — Contour map ────────────────────────────────────────────────
  const geometryNote = w.say(!input.geometry.cartographic ? 'CS_analytical'
    : input.geometry.analyticalAvailable ? 'CS_cartographicGis' : 'CS_cartographic');
  const caveat = exploratory ? decision.caveats[0] ?? '' : '';
  const mapPage: ContourPdfPage = {
    title: w.say('CS_summary'),
    lines: [
      geometryNote,
      w.say('CS_verticalUnit', { u_u: unit(p.verticalUnit) }),
      evidenceLine,
      ...(watermark === null ? [] : [caveat === ''
        ? w.say('CS_watermarkedBare', { u_m: watermark })
        : w.say('CS_watermarked', { u_m: watermark, u_c: tr(caveat) }).trim()]),
    ],
  };

  // ── Page 2 — Surface support ────────────────────────────────────────────
  const supportPage: ContourPdfPage = {
    title: w.say('CS_support'),
    lines: [
      w.say('CS_measured', { n: num(input.support.measuredPct) }),
      w.say('CS_interpolated', { n: num(input.support.interpolatedPct) }),
      w.say('CS_unsupported', { n: num(input.support.unsupportedPct) }),
    ],
  };

  // ── Page 3 — Validation ─────────────────────────────────────────────────
  const { mode, rmseM, sampleSize, independentCheckpoints } = input.validation;
  const validationPage: ContourPdfPage = {
    title: w.say('CS_validation'),
    lines: [
      w.say('CS_mode', { u_m: need(w.plain ? mode : w.word('MODE', mode), mode) }),
      w.say('CS_rmse', { n: rmseM == null ? '—' : `${num(rmseM)} m` }),
      w.say('CS_sample', { n: sampleSize }),
      w.say(independentCheckpoints ? 'CS_checkYes' : 'CS_checkNo'),
    ],
  };

  // ── Page 4 — Method and provenance ──────────────────────────────────────
  const isDigest = /^[0-9a-f]{8,}$/i.test(p.sourceSha256);
  const provenancePage: ContourPdfPage = {
    title: w.say('CS_method'),
    lines: [
      w.say('CS_sha', { u_v: isDigest ? p.sourceSha256 : tr(p.sourceSha256) }),
      w.say('CS_record', { u_v: p.recordHash }),
      w.say('CS_crs', { u_v: known(p.crs, 'not georeferenced') }),
      w.say('CS_datum', { u_v: known(p.verticalDatum, 'unknown') }),
      w.say('CS_horizontalUnit', { u_u: unit(p.horizontalUnit) }),
      w.say('CS_verticalUnit', { u_u: unit(p.verticalUnit) }),
      w.say('CS_grid', { u_v: tr(p.grid) }),
      w.say('CS_methods', { u_v: p.methodIds.join(', ') }),
      w.say('CS_software', { u_v: software }),
      w.say('CS_commit', { u_v: p.gitCommit.includes(' built ') ? tr(p.gitCommit) : p.gitCommit }),
      w.say('CS_generatedLine', { u_v: p.generated }),
    ],
  };

  const pages: ContourPdfPage[] = [mapPage, supportPage, validationPage, provenancePage];

  // ── Optional Page 5 — Standards traceability (§20.5) ────────────────────
  if (input.standardsTraceability) {
    pages.push({ title: w.say('CS_standards'), lines: [w.say('CS_thresholds'), w.say('CS_marks')] });
  }

  return {
    titleBlock, evidenceBadge, watermark, pages,
    ...(w.locale.lang === 'en' ? {} : { languageTag: w.tag, fallbackTitle: w.say('CS_fallbackTitle') }),
  };
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
