/**
 * localizeSheet.ts: a drawn sheet's words and numbers in the export language.
 *
 * Shared by the sheets whose catalog holds one row per phrase (the profile set
 * and the contour map sheet). `say` fills a row of the catalog. `translate`
 * takes an English sentence another module wrote, finds its row and fills it
 * in the export language, so a sentence has one English source. English with
 * point decimals comes back exactly as it was. A sentence with no row stays in
 * English and is reported to `onMiss`, which a test turns into a failure.
 *
 * Row parameters: `{n}` is a figure, rewritten in the number style; `{t_x}` is
 * a phrase with a row of its own; `{l_x}` is a list holding such phrases;
 * `{u_x}` is copied exactly (a name, a code, a time, text the user typed).
 */
import { languageInfo, type ExportLanguage } from '../i18n/languages';
import { ENGLISH, type ExportLocale } from '../i18n/exportLocale';
import { restyleNumbers } from '../i18n/numberStyle';
import { fill } from '../i18n/message';

/** One phrase in each export language, in the order of `EXPORT_LANGUAGES`. */
export type SheetTextRow = readonly [en: string, es: string, pt: string, fr: string, de: string];

export const SHEET_TEXT_COLUMN: Readonly<Record<ExportLanguage, 0 | 1 | 2 | 3 | 4>> = { en: 0, es: 1, pt: 2, fr: 3, de: 4 };

export interface SheetWords<K extends string> {
  readonly locale: ExportLocale;
  /** BCP 47 tag for the PDF. */
  readonly tag: string;
  /** The footer's draft note, or null when the language is reviewed or English. */
  readonly draft: string | null;
  /** A catalog phrase. `{n}`-style parameters are figures and take the number style; `u_` ones are copied. */
  say(key: K, params?: Readonly<Record<string, string | number>>): string;
  /** An English sentence from another module, in the export language. */
  translate(text: string): string;
  /** Figures already written with a point, in the export's number style. */
  num(text: string): string;
}

/** The rows with a part in the machinery itself. */
export interface SheetTextRoles<K extends string> {
  /** The "(unit unverified)" a figure can carry. */
  readonly unverified: K;
  /** The footer's draft note, with the language's name as `{u_name}`. */
  readonly draft: K;
  /** Phrases that stand inside a list (`l_`), and the word that joins them. */
  readonly listed?: readonly K[];
  readonly listAnd?: K;
}

interface Matcher<K> { readonly key: K; readonly res: readonly RegExp[]; readonly names: string[]; readonly weight: number }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The localizer of one catalog. The matchers are built once, when the sheet's chunk loads. */
export function sheetLocalizer<K extends string>(
  text: Readonly<Record<K, SheetTextRow>>,
  roles: SheetTextRoles<K>,
): (locale?: ExportLocale, onMiss?: (text: string) => void) => SheetWords<K> {
  /** Rows that are matched as whole phrases, and rows with parameters, the most literal first. */
  const exact = new Map<string, K>();
  const matchers: Matcher<K>[] = [];
  for (const key of Object.keys(text) as K[]) {
    const en = text[key][0];
    const names: string[] = [];
    const parts = en.split(/(\{\w+\})/).filter((p) => p !== '');
    if (!parts.some((p) => /^\{\w+\}$/.test(p))) {
      if (!exact.has(en)) exact.set(en, key);
      continue;
    }
    const pattern = (phrase: string): string => parts.map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return escapeRe(part);
      // A figure holds a digit and no sentence; names and phrases can be anything.
      return /^[tlu]_/.test(m[1]!) ? phrase : "([^;:]*?\\d[^;:]*?)";
    }).join('');
    for (const part of parts) { const m = /^\{(\w+)\}$/.exec(part); if (m) names.push(m[1]!); }
    // A phrase can hold its neighbour's separator, so both the shortest and the longest first part are tried.
    matchers.push({ key, res: ['(.+?)', '(.+)'].map((q) => new RegExp(`^${pattern(q)}$`, 's')), names, weight: en.replace(/\{\w+\}/g, '').length });
  }
  matchers.sort((a, b) => b.weight - a.weight);

  return (locale = ENGLISH, onMiss) => {
    const info = languageInfo(locale.lang);
    const plain = locale.lang === 'en' && locale.numberStyle === 'point';
    const T = (key: K): string => text[key][SHEET_TEXT_COLUMN[locale.lang]];
    const num = (s: string): string => {
      if (plain) return s;
      return restyleNumbers(s.replaceAll(text[roles.unverified][0], T(roles.unverified)), locale.numberStyle);
    };
    const say: SheetWords<K>['say'] = (key, params = {}) => {
      const p: Record<string, string> = {};
      for (const [n, v] of Object.entries(params)) p[n] = n.startsWith('t_') ? translate(String(v)) : n.startsWith('u_') ? String(v) : num(String(v));
      return fill(T(key), p, key);
    };
    /** The list with its phrases and, right after one, its "and" in the export language; a name keeps its own. */
    const list = (v: string): string => (roles.listed ?? []).reduce((s, k) => {
      const en = text[k][0];
      const joined = roles.listAnd ? s.replaceAll(en + text[roles.listAnd][0], T(k) + T(roles.listAnd)) : s;
      return joined.replaceAll(en, T(k));
    }, v);
    /** The text's translation, or null when it has no row. */
    function find(s: string): string | null {
      const hit = exact.get(s);
      if (hit) return T(hit);
      for (const m of matchers) for (const re of m.res) {
        const got = re.exec(s);
        if (!got) break;
        const p: Record<string, string> = {};
        let ok = true;
        for (let i = 0; i < m.names.length && ok; i++) {
          const n = m.names[i]!, v = got[i + 1]!;
          if (n.startsWith('t_')) {
            const inner = find(v);
            if (inner === null) ok = false; else p[n] = inner;
          } else if (n.startsWith('l_')) p[n] = list(v);
          else if (n.startsWith('u_')) p[n] = v;
          else p[n] = num(v);
        }
        if (ok) return fill(T(m.key), p, m.key);
      }
      return null;
    }
    function translate(s: string): string {
      if (plain) return s;
      const got = find(s);
      if (got !== null) return got;
      // Figures alone need no row: "1.35 m / 4.89 m", "64 · 100%", "—".
      const bare = s.replaceAll(text[roles.unverified][0], '');
      if (/[A-Za-z]{3,}/.test(bare)) onMiss?.(s);
      return num(s);
    }
    return {
      locale, tag: info.tag,
      draft: info.reviewed ? null : T(roles.draft).replace('{u_name}', info.name),
      say, translate, num,
    };
  };
}
