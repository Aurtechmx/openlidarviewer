/**
 * localizeTerrainReport.ts: the terrain report's content in the export
 * language.
 *
 * Works on the English content, row by row. Names, CRS and datum text, file
 * digests, method ids, versions and times are copied from the record they came
 * from, so a scan called "Good" keeps its name. When any sentence has no
 * translation the whole report stays in English and its provenance says so: a
 * report is never half translated.
 */
import { languageInfo } from '../../i18n/languages';
import { ENGLISH, type ExportLocale } from '../../i18n/exportLocale';
import { kv, type ExportProvenance } from './exportProvenance';
import { reportWords, type ReportWords } from './reportWords';
import type { TerrainReportContent, TerrainReportRow } from './terrainReportContent';

export interface LocalizedTerrainReport {
  readonly content: TerrainReportContent;
  /** The words the report is drawn with: the language asked for, or English. */
  readonly words: ReportWords;
  /** The first English text with no translation, or null. */
  readonly missed: string | null;
}

class Untranslated extends Error {}
const need = (got: string | null, text: string): string => {
  if (got === null) throw new Untranslated(text);
  return got;
};

/** `First — rest`, the first part a word of one field. */
function pair(text: string, prefix: string, w: ReportWords): string {
  const i = text.indexOf(' — ');
  const head = i < 0 ? text : text.slice(0, i);
  const said = need(w.word(prefix, head), text);
  if (i < 0) return said;
  const rest = text.slice(i + 3);
  return w.say('X_pair', { u_a: said, u_b: need(w.translate(rest), rest) });
}

function crsOrigin(p: ExportProvenance, w: ReportWords): string {
  const o = p.crsOrigin;
  const unknown = w.say('CRS_unknown');
  const source = (s: string): string => {
    const m = /^(\S+)( \(.+\))?$/s.exec(s);
    return need(m && w.word('CRS', m[1]!), s) + (m?.[2] ?? '');
  };
  const or = (v: string): string => (v === 'unknown' ? unknown : v);
  return w.say('X_crsLine', {
    u_s: source(o.source), u_n: o.source === 'unknown' ? or(o.name) : o.name, u_e: or(o.epsg),
    u_v: o.verticalDatum === 'unknown' ? w.say('crsNoVertical') : w.say('X_crsVertical', { u_d: o.verticalDatum, u_s: source(o.verticalSource) }),
  });
}

function scopedEvidence(p: ExportProvenance, text: string, w: ReportWords): string {
  const s = p.scopedEvidence;
  const m = /^.+?; baseline .+? → effective (.+); study .+?$/s.exec(text);
  if (!s || !m) throw new Untranslated(text);
  return w.say('X_scopedLine', {
    u_s: need(w.word('RS', s.resolutionState), text),
    u_b: s.baselineEvidence ?? w.say('EV_unregistered'),
    u_e: s.effectiveEvidence ?? (m[1] === 'unregistered' ? w.say('EV_unregistered') : need(w.translate(m[1]!), m[1]!)),
    u_y: s.matchedScopedStudy ?? w.say('EV_none'),
  });
}

/** The application and its version, which can be unknown. */
const software = (text: string, w: ReportWords): string => text.replace(/ unknown$/, () => ` ${w.say('unknown')}`);

/** A provenance value by its English key. */
function provenanceValue(key: string, value: string, p: ExportProvenance, w: ReportWords): string {
  const tr = (): string => need(w.translate(value), value);
  switch (key) {
    case 'Software': return software(value, w);
    case 'Metric version': return value === 'unknown' ? tr() : value;
    case 'Generated': case 'Methods': case 'Source realization': case 'Target realization':
      return value;
    case 'Source': return p.source === null ? tr() : value;
    case 'Horizontal CRS': return p.crsKnown ? value : tr();
    case 'Vertical datum': return p.datumKnown ? value : tr();
    case 'Coverage': case 'Data basis': return need(w.word('COV', value), value);
    case 'Interpretation': return need(w.word('IL', value), value);
    case 'Source SHA-256': return p.sourceSha256 !== null ? value : tr();
    case 'Input SHA-256': return p.analysisInputSha256 !== null ? value : tr();
    case 'CRS origin': return crsOrigin(p, w);
    case 'Contour interval': {
      const m = /^(\S+) (m|ft|units)$/.exec(value);
      return m ? `${w.num(m[1]!)} ${w.word('UNIT', m[2]!)}` : tr();
    }
    case 'Contour style': return need(w.word('ST', value), value);
    case 'Surface quality': return need(w.word('SQ', value), value);
    case 'Export readiness': return pair(value, 'ER', w);
    case 'Transform operation': return value.startsWith('no transform') ? tr() : value;
    case 'Coordinate epoch': return w.num(value);
    case 'Scoped evidence': return scopedEvidence(p, value, w);
    case 'Export permit': return value.split(' — ').map((s) => need(w.word('PERMIT', s), s)).join(' — ');
    default: return tr();
  }
}

/** One `Key  Value` line of the stamp. */
function provenanceLine(line: string, p: ExportProvenance, w: ReportWords): string {
  const m = /^(.+?) {2,}(.+)$/s.exec(line);
  if (!m) throw new Untranslated(line);
  const key = m[1]!;
  return kv(need(w.translate(key), key), provenanceValue(key, m[2]!, p, w));
}

function rowValue(row: TerrainReportRow, p: ExportProvenance, w: ReportWords): string {
  const v = row.value;
  const tr = (): string => need(w.translate(v), v);
  switch (row.label) {
    case 'Scan': return p.source === null ? tr() : v;
    case 'Horizontal CRS': return p.crsKnown ? v : tr();
    case 'Vertical datum': return p.datumKnown ? v : tr();
    case 'Generated': return v;
    case 'Software': return software(v, w);
    case 'Verdict': return pair(v, 'SQ', w);
    case 'Surface quality': return need(w.word('SQ', v), v);
    case 'Export readiness': return pair(v, 'ER', w);
    case 'Grid extent walked': case 'Data basis': return need(w.word('COV', v), v);
    case 'Interpretation level': return need(w.word('IL', v), v);
    case 'Terrain complexity': return need(w.word('CX', v), v);
    case 'Volumetric point density (all returns, bounding box)':
    case 'Areal point density (all returns, header footprint)': return need(w.word('DE', v), v);
    case 'Ground visibility': {
      const bare = w.word('GV', v);
      if (bare !== null) return bare;
      const label = v.replace(/ \(.*$/s, '');
      const share = ' (ground share after excluding classified vegetation and buildings)';
      if (v !== label + share) throw new Untranslated(v);
      return w.say('X_visibilityShare', { u_label: need(w.word('GV', label), v) });
    }
    default: return tr();
  }
}

function productValue(value: string, w: ReportWords): string {
  const m = /^(Available|Preview|Blocked)(?: — (.+))? · Evidence level: (.+)$/s.exec(value);
  if (!m) throw new Untranslated(value);
  const status = need(w.word('AV', m[1]!), value);
  return w.say('X_product', {
    u_status: m[2] ? w.say('X_pair', { u_a: status, u_b: need(w.translate(m[2]), m[2]) }) : status,
    t_evidence: need(w.translate(m[3]!), m[3]!),
  });
}

function translated(c: TerrainReportContent, w: ReportWords): TerrainReportContent {
  const p = c.provenance;
  const tr = (s: string): string => need(w.translate(s), s);
  return {
    ...c,
    title: p.source === null ? tr(c.title) : c.title,
    subtitle: tr(c.subtitle),
    sections: c.sections.map((sec) => ({
      title: tr(sec.title),
      rows: sec.rows.map((row): TerrainReportRow => {
        const mark = /^([✓⚠✕]) (.+)$/.exec(row.label);
        return {
          // The English label still decides whether a long value may be capped.
          capLabel: row.label,
          label: mark ? `${mark[1]} ${tr(mark[2]!)}` : tr(row.label),
          value: sec.title === 'Terrain Products Available' ? productValue(row.value, w) : rowValue(row, p, w),
        };
      }),
    })),
    warnings: c.warnings.map(tr),
    howToImprove: c.howToImprove.map(tr),
    provenanceLines: [
      ...c.provenanceLines.map((l) => provenanceLine(l, p, w)),
      ...(w.draft ? [kv(w.say('kLanguage'), w.draft)] : []),
    ],
    notSurveyGrade: tr(c.notSurveyGrade),
    definitions: c.definitions.map(tr),
  };
}

/** The report's content in `locale`, or in English when a sentence has no translation. */
export function localizeTerrainReport(content: TerrainReportContent, locale: ExportLocale = ENGLISH): LocalizedTerrainReport {
  const words = reportWords(locale);
  if (words.plain) return { content, words, missed: null };
  try {
    return { content: translated(content, words), words, missed: null };
  } catch (err) {
    if (!(err instanceof Untranslated)) throw err;
    const english = reportWords();
    return {
      content: { ...content, provenanceLines: [...content.provenanceLines, kv('Language', english.say('X_languageFallback', { u_name: languageInfo(locale.lang).name }))] },
      words: english,
      missed: err.message,
    };
  }
}
