/**
 * profilePdfParts.ts: the pieces profilePdf.ts hands the styled set that are
 * not drawn by it: the user's logo, the groups of the technical notes, and the
 * method sheet's sections. Pure apart from embedding an image.
 */
import type { PDFDocument, PDFImage } from 'pdf-lib';
import { heightLabel, type VerticalReference } from '../../geo/height';
import { cleanLogo } from '../../model/deliverableFields';
import type { SourceReduction, WithheldReadCounts } from '../../science/withheldCounts';
import type { DerivedSurfaceLegend } from './profileDerivedLegend';
import { DATUM_CONFLICT_MEASURE_NOTICE } from './format';
import { drawMethodSheets, drawNotesSheet, drawScheduleSheets, drawSetFooters, type ProfileSetContext } from './profileSheetPages';
import { STATUS_KEY, titleBlockRows, type ProfileStationSample } from './profileSheetStyled';
import { describeSampleBasis, describeSampleCaveat, formatCount, type ProfileProvenance } from './profileProvenance';

// The styled set's other parts, so profilePdf.ts reaches all of it through this module.
export { profileWords } from '../../export/localizeProfile';
export { countsPerStation, drawStyledProfileSheet, embedSheetFonts, planMissingNote, profilePalette, profileScaleRatios, STATUS_KEY } from './profileSheetStyled';

export interface MethodSheetInput {
  readonly legend: DerivedSurfaceLegend;
  readonly record: ProfileProvenance | null;
  readonly reference: VerticalReference;
  readonly crs: string | null;
  readonly verticalDatum: string | null;
  readonly datumKnown: boolean;
  /** How the loaded cloud was reduced, or null for a whole cloud. */
  readonly reduction: SourceReduction | null;
  readonly pointsRead: WithheldReadCounts | null;
}

/** The user's logo, or null when there is none or its bytes are not a usable image. */
export async function embedLogo(doc: PDFDocument, url: string | undefined): Promise<PDFImage | null> {
  const clean = cleanLogo(url);
  if (!clean) return null;
  try {
    return clean.startsWith('data:image/png') ? await doc.embedPng(clean) : await doc.embedJpg(clean);
  } catch {
    return null;
  }
}

/** The group a technical note is set under on a styled sheet. */
export function noteGroup(item: string): 'groupGeometry' | 'groupGrade' | 'groupSampling' | 'groupReference' {
  if (/grad(e|ient)|^steepest/i.test(item)) return 'groupGrade';
  if (/^(samples|corridor|sources|derived|class|read)/i.test(item)) return 'groupSampling';
  if (/^(vertical|horizontal)/i.test(item)) return 'groupReference';
  return 'groupGeometry';
}

export const NO_SOURCE_RECORD =
  'No provenance record was attached to this export, so the contributing sources, ' +
  'their classification and the read scope are not recorded on this sheet.';

export function residencyWord(s: ProfileProvenance['sources'][number]): string {
  return !s.streaming ? '-' : s.residency === true ? 'complete' : s.residency === false ? 'incomplete' : 'unknown';
}

/** The method sheet's sections for a styled set: the sentences the Classic method sheet prints. */
export function methodSections(m: MethodSheetInput): Array<{ head: string; lines: string[] }> {
  return [
    { head: 'Derived series', lines: m.legend.lines.slice(1) },
    {
      head: 'Height reference',
      lines: [
        `${heightLabel(m.reference)}. See general note 2.`,
        `Vertical datum: ${m.verticalDatum ?? 'not declared'}`,
        `Horizontal CRS: ${m.crs ?? 'not georeferenced'}`,
        ...(m.datumKnown ? [] : [DATUM_CONFLICT_MEASURE_NOTICE]),
      ],
    },
    ...(m.reduction == null ? [] : [{
      head: 'Sample basis',
      lines: [
        `${describeSampleBasis(m.reduction)}.`,
        describeSampleCaveat(m.reduction),
        ...(m.pointsRead == null ? [] : [`${formatCount(m.pointsRead.analysedPoints)} of ${formatCount(m.pointsRead.sourcePoints)} sample points were analysed.`]),
      ],
    }]),
    ...(m.record == null ? [] : [{
      head: 'Read scope',
      lines: [
        'See general note 3.',
        `Method ${m.record.method}, corridor definition version ${String(m.record.corridorVersion)}, record version ${String(m.record.recordVersion)}, captured ${m.record.capturedAt}.`,
        ...(m.record.upDegenerate ? ['The scene up axis was degenerate when this sample was taken, so the heights were not measured along a usable vertical.'] : []),
      ],
    }]),
  ];
}

/** Entries two by two. */
function pairs<E>(list: readonly E[]): Array<[E, E | undefined]> {
  return Array.from({ length: Math.ceil(list.length / 2) }, (_, i) => [list[2 * i]!, list[2 * i + 1]]);
}

/** Sheets two on of a styled set, with their footers, from what profilePdf.ts worked out. */
export function drawFollowingSheets(set: ProfileSetContext, p: {
  readonly method: MethodSheetInput;
  readonly rows: ReadonlyArray<{ readonly item: string; readonly value: string; readonly remark: string; readonly limit?: boolean }>;
  /** The general notes, in the export language. */
  readonly notes: readonly string[];
  readonly scanName: string | null;
  readonly declaredDatum: string | null;
  readonly station: ProfileStationSample | null;
  readonly heightWord: string;
  readonly formatStation: (m: number) => string;
  readonly k: number;
  readonly unit: string;
}): void {
  const words = set.words, own = set.deliverable, record = p.method.record;
  const document: Array<[string, string]> = [
    ...(own.company ? [[words.say('fCompany'), own.company] as [string, string]] : []),
    ...(own.project ? [[words.say('fProject'), own.project] as [string, string]] : []),
    ...titleBlockRows(own, words),
  ];
  if (document.length > 0 || own.status) {
    document.push([words.say('fStatus'), words.say(STATUS_KEY[own.status ?? 'preliminary'])]);
    // A project of the user's own takes the scan's place in the header, so the scan is named here.
    if (own.project && p.scanName) document.push([words.say('fSource'), p.scanName]);
  }
  // A CRS or a datum is a name: copied, never translated or restyled.
  const verbatim = new Set([p.method.crs, p.declaredDatum].filter((v) => v != null));
  drawNotesSheet(set, [
    ...pairs(document).map(([a, b]) => ({ group: words.say('groupDocument'), item: a[0], value: a[1], remark: '', ...(b ? { second: b } : {}) })),
    ...p.rows.map((r) => ({
      group: words.say(noteGroup(r.item)), item: words.translate(r.item), value: verbatim.has(r.value) ? r.value : words.translate(r.value),
      remark: words.translate(r.remark), limit: r.limit,
    })),
  ]);
  drawScheduleSheets(set, { formatStation: p.formatStation, k: p.k, unit: p.unit, heightHead: words.translate(p.heightWord.replace(/ \(.*\)$/, '')) });
  drawMethodSheets(set, {
    sections: methodSections(p.method).map((m) => ({ head: words.translate(m.head), lines: m.lines.map((ln) => words.translate(ln)) })),
    notes: p.notes,
    sources: record == null ? null : record.sources.map((src) => ({
      name: src.displayName !== '' ? src.displayName : '-', id: src.layerId, classification: words.translate(src.classification),
      read: words.say(src.streaming ? 'wStreaming' : 'wStatic'), accepted: words.num(formatCount(src.acceptedCount)), contributed: words.say(src.contributed ? 'wYes' : 'wNo'),
      residency: words.translate(residencyWord(src)),
    })),
    noSources: words.say('noSources'),
    totalAccepted: record == null ? null : formatCount(record.acceptedCount),
    station: p.station, formatStation: p.formatStation, k: p.k, unit: p.unit,
  });
  drawSetFooters(set, 1, set.doc.getPageCount());
}
