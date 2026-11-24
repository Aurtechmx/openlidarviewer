/**
 * localizeProfile.ts: the profile sheet's words and numbers in the export
 * language.
 *
 * `say` fills a row of the catalog. `translate` takes an English sentence
 * another module wrote, finds its row and fills it in the export language, so
 * a sentence has one English source. English with point decimals comes back
 * exactly as it was. A sentence with no row stays in English and is reported
 * to `onMiss`, which a test turns into a failure.
 */
import { PROFILE_SHEET_TEXT, profileSheetTemplate, type ProfileSheetKey } from '../i18n/deliverables/profileSheet';
import { languageInfo } from '../i18n/languages';
import { ENGLISH, type ExportLocale } from '../i18n/exportLocale';
import { restyleNumbers } from '../i18n/numberStyle';
import { fill } from '../i18n/message';

export interface ProfileWords {
  readonly locale: ExportLocale;
  /** BCP 47 tag for the PDF. */
  readonly tag: string;
  /** The footer's draft note, or null when the language is reviewed or English. */
  readonly draft: string | null;
  /** A catalog phrase. `{n}`-style parameters are figures and take the number style; `u_` ones are copied. */
  say(key: ProfileSheetKey, params?: Readonly<Record<string, string | number>>): string;
  /** An English sentence from another module, in the export language. */
  translate(text: string): string;
  /** Figures already written with a point, in the export's number style. */
  num(text: string): string;
}

interface Matcher { readonly key: ProfileSheetKey; readonly res: readonly RegExp[]; readonly names: string[]; readonly weight: number }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rows that are matched as whole phrases, and rows with parameters, the most literal first. */
const EXACT = new Map<string, ProfileSheetKey>();
const MATCHERS: Matcher[] = [];
for (const key of Object.keys(PROFILE_SHEET_TEXT) as ProfileSheetKey[]) {
  const en = PROFILE_SHEET_TEXT[key][0];
  const names: string[] = [];
  const parts = en.split(/(\{\w+\})/).filter((p) => p !== '');
  if (!parts.some((p) => /^\{\w+\}$/.test(p))) {
    if (!EXACT.has(en)) EXACT.set(en, key);
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
  MATCHERS.push({ key, res: ['(.+?)', '(.+)'].map((q) => new RegExp(`^${pattern(q)}$`, 's')), names, weight: en.replace(/\{\w+\}/g, '').length });
}
MATCHERS.sort((a, b) => b.weight - a.weight);

/** Phrases that stand inside a list (`l_`). */
const LISTED: readonly ProfileSheetKey[] = ['cpProducer', 'cpDerived', 'cpAbsent', 'methodNone'];

export function profileWords(locale: ExportLocale = ENGLISH, onMiss?: (text: string) => void): ProfileWords {
  const info = languageInfo(locale.lang);
  const plain = locale.lang === 'en' && locale.numberStyle === 'point';
  const T = (key: ProfileSheetKey): string => profileSheetTemplate(locale.lang, key);
  const num = (s: string): string => {
    if (plain) return s;
    return restyleNumbers(s.replaceAll(PROFILE_SHEET_TEXT.vUnverified[0], T('vUnverified')), locale.numberStyle);
  };
  const say: ProfileWords['say'] = (key, params = {}) => {
    const p: Record<string, string> = {};
    for (const [n, v] of Object.entries(params)) p[n] = n.startsWith('t_') ? translate(String(v)) : n.startsWith('u_') ? String(v) : num(String(v));
    return fill(T(key), p, key);
  };
  /** The text's translation, or null when it has no row. */
  function find(text: string): string | null {
    const hit = EXACT.get(text);
    if (hit) return T(hit);
    for (const m of MATCHERS) for (const re of m.res) {
      const got = re.exec(text);
      if (!got) break;
      const p: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < m.names.length && ok; i++) {
        const n = m.names[i]!, v = got[i + 1]!;
        if (n.startsWith('t_')) {
          const inner = find(v);
          if (inner === null) ok = false; else p[n] = inner;
        } else if (n.startsWith('l_')) p[n] = LISTED.reduce((s, k) => {
          // An "and" joins items only right after one of these phrases; a name keeps its own.
          const en = PROFILE_SHEET_TEXT[k][0];
          return s.replaceAll(en + PROFILE_SHEET_TEXT.listAnd[0], T(k) + T('listAnd')).replaceAll(en, T(k));
        }, v);
        else if (n.startsWith('u_')) p[n] = v;
        else p[n] = num(v);
      }
      if (ok) return fill(T(m.key), p, m.key);
    }
    return null;
  }
  function translate(text: string): string {
    if (plain) return text;
    const got = find(text);
    if (got !== null) return got;
    // Figures alone need no row: "1.35 m / 4.89 m", "64 · 100%", "—".
    const bare = text.replaceAll(PROFILE_SHEET_TEXT.vUnverified[0], '');
    if (/[A-Za-z]{3,}/.test(bare)) onMiss?.(text);
    return num(text);
  }
  return {
    locale, tag: info.tag,
    draft: info.reviewed ? null : T('footDraft').replace('{u_name}', info.name),
    say, translate, num,
  };
}
