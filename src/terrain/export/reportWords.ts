/**
 * reportWords.ts: the terrain report's and Contour Studio PDF's words and
 * numbers in the export language.
 *
 * `say` fills a row of the catalog. `word` translates a one-field word, such
 * as a readiness tier. `translate` takes an English sentence another module
 * wrote, finds its row and fills it in the export language, so a sentence has
 * one English wording. Both return null for text with no row: the caller then
 * writes the whole report in English, never half of it.
 *
 * English with point decimals comes back exactly as it was.
 */
import { TERRAIN_REPORT_TEXT, terrainReportTemplate, type TerrainReportKey } from '../../i18n/deliverables/terrainReport';
import { languageInfo } from '../../i18n/languages';
import { ENGLISH, type ExportLocale } from '../../i18n/exportLocale';
import { restyleNumbers } from '../../i18n/numberStyle';
import { fill } from '../../i18n/message';

export interface ReportWords {
  readonly locale: ExportLocale;
  /** English with point decimals: the report as it always was. */
  readonly plain: boolean;
  /** BCP 47 tag for the PDF. */
  readonly tag: string;
  /** The draft note, or null when the language is reviewed or English. */
  readonly draft: string | null;
  /** A catalog phrase. `{n}`-style parameters take the number style; the others are copied. */
  say(key: TerrainReportKey, params?: Readonly<Record<string, string | number>>): string;
  /** A word of one field (`SQ`, `COV`), or null when it has no row. */
  word(prefix: string, text: string): string | null;
  /** An English sentence from another module, or null when it has no row. */
  translate(text: string): string | null;
  /** Figures already written with a point, in the export's number style. */
  num(text: string): string;
}

interface Matcher { readonly key: TerrainReportKey; readonly res: readonly RegExp[]; readonly names: readonly string[]; readonly list: boolean; readonly weight: number }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A figure, with its unit if it has one, or the dash that stands for none. */
const FIGURE = '((?:>= |-)?\\d[\\d.,]*(?:e[+-]?\\d+)?(?: (?:source Z units|z-units|units|ft|m))?|—)';

const EXACT = new Map<string, TerrainReportKey>();
const FIELD = new Map<string, TerrainReportKey>();
const MATCHERS: Matcher[] = [];
for (const key of Object.keys(TERRAIN_REPORT_TEXT) as TerrainReportKey[]) {
  const en = TERRAIN_REPORT_TEXT[key][0];
  const parts = en.split(/(\{\w+\})/).filter((p) => p !== '');
  const names = parts.flatMap((p) => /^\{(\w+)\}$/.exec(p)?.[1] ?? []);
  const prefix = /^([A-Z]+)_/.exec(key)?.[1];
  if (prefix !== undefined) {
    if (names.length === 0) FIELD.set(`${prefix} ${en}`, key);
    continue;
  }
  if (names.length === 0) {
    if (!EXACT.has(en)) EXACT.set(en, key);
    continue;
  }
  const pattern = (phrase: string): string => parts.map((part) => {
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name === undefined) return escapeRe(part);
    if (name.startsWith('c_')) return '(\\S+)';
    return /^[tujJ]_/.test(name) ? phrase : FIGURE;
  }).join('');
  MATCHERS.push({
    key, names, list: names.some((n) => /^[jJ]_/.test(n)),
    // A phrase can hold its neighbour's separator, so both the shortest and the longest first part are tried.
    res: ['(.+?)', '(.+)'].map((q) => new RegExp(`^${pattern(q)}$`, 's')),
    weight: en.replace(/\{\w+\}/g, '').length,
  });
}
MATCHERS.sort((a, b) => b.weight - a.weight);

/** How a list of phrases is joined: "a and b", "a, b, and c". */
const AND: Readonly<Record<ExportLocale['lang'], string>> = { en: ' and ', es: ' y ', pt: ' e ', fr: ' et ', de: ' und ' };

const lowerFirst = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

export function reportWords(locale: ExportLocale = ENGLISH): ReportWords {
  const { lang, numberStyle } = locale;
  const info = languageInfo(lang);
  const plain = lang === 'en' && numberStyle === 'point';
  const comma = numberStyle === 'comma';

  /** A row's template: its own figures in the number style, a DOI left alone, and the space French and German put before a sign kept on the line. */
  const T = (key: TerrainReportKey): string => {
    let s: string = terrainReportTemplate(lang, key);
    if (comma) s = s.split(/(doi:\S+|\{\w+\})/).map((p, i) => (i % 2 ? p : restyleNumbers(p, numberStyle))).join('');
    if (lang === 'fr') s = s.replace(/ (?=[%:;])/g, ' ');
    if (lang === 'de') s = s.replace(/ (?=%)/g, ' ');
    return s;
  };
  const num = (s: string): string => {
    if (plain) return s;
    return restyleNumbers(s, numberStyle).replace(/ (source Z units|z-units|units)$/, (_, u: string) => ` ${T(FIELD.get(`UNIT ${u}`)!)}`);
  };
  const say: ReportWords['say'] = (key, params = {}) => {
    const p: Record<string, string> = {};
    for (const [n, v] of Object.entries(params)) p[n] = /^[a-zA-Z]_/.test(n) ? String(v) : num(String(v));
    return fill(T(key), p, key);
  };
  const word = (prefix: string, text: string): string | null => {
    const key = FIELD.get(`${prefix} ${text}`);
    return key === undefined ? null : T(key);
  };

  /** The items of an English list, each translated, or null when one has no row. */
  function items(text: string, atLeast = 1): string[] | null {
    const whole = atLeast <= 1 ? find(text, true) : null;
    if (whole !== null) return [whole];
    for (const m of text.matchAll(/, and |, | and /g)) {
      const head = find(text.slice(0, m.index), true);
      if (head === null) continue;
      const rest = items(text.slice(m.index + m[0].length));
      if (rest) return [head, ...rest];
    }
    return null;
  }
  function join(parts: readonly string[]): string {
    if (parts.length === 1) return parts[0]!;
    const head = parts.slice(0, -1).join(', ');
    return `${head}${lang === 'en' && parts.length > 2 ? ',' : ''}${AND[lang]}${parts.at(-1)}`;
  }

  function param(name: string, v: string): string | null {
    if (name === 't_unit') return word('UNIT', v);
    if (name.startsWith('t_')) return find(v, false);
    if (name.startsWith('j_')) { const l = items(v); return l && join(l); }
    if (name.startsWith('J_')) { const l = items(v) ?? items(lowerFirst(v)); return l && upperFirst(join(l)); }
    return /^[cu]_/.test(name) ? v : num(v);
  }
  function find(text: string, single: boolean): string | null {
    const hit = EXACT.get(text);
    if (hit) return T(hit);
    for (const m of MATCHERS) {
      if (single && m.list) continue;
      for (const re of m.res) {
        const got = re.exec(text);
        if (!got) break;
        const p: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < m.names.length && ok; i++) {
          const v = param(m.names[i]!, got[i + 1]!);
          if (v === null) ok = false; else p[m.names[i]!] = v;
        }
        if (ok) return fill(T(m.key), p, m.key);
      }
    }
    return null;
  }
  const FIGURE_ONLY = new RegExp(`^${FIGURE}$`);
  /** The text as one phrase, or as a run of sentences each with a row. */
  function translate(text: string): string | null {
    if (plain) return text;
    if (text === '' || FIGURE_ONLY.test(text)) return num(text);
    const whole = find(text, false);
    if (whole !== null) return whole;
    for (let i = text.indexOf('. '); i !== -1; i = text.indexOf('. ', i + 2)) {
      const head = find(text.slice(0, i + 1), false);
      if (head === null) continue;
      const rest = translate(text.slice(i + 2));
      if (rest !== null) return `${head} ${rest}`;
    }
    return null;
  }
  return {
    locale, plain, tag: info.tag,
    draft: info.reviewed ? null : say('X_languageDraft', { u_name: info.name }),
    say, word, translate, num,
  };
}

