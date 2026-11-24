/**
 * localizeDrainage.ts: the drainage sheet's lines in the export language.
 *
 * A line is written in English by the sheet and the modules it quotes; this
 * finds its row (i18n/deliverables/drainageSheet.ts) and fills it in the
 * export language and number style. English with point decimals comes back
 * exactly as it was. A line with no row stays in English and is reported to
 * `onMiss`, which a test turns into a failure.
 */
import { DRAINAGE_SHEET_ROWS } from '../i18n/deliverables/drainageSheet';
import { fill } from '../i18n/message';
import { restyleNumbers } from '../i18n/numberStyle';
import type { ReportLocale } from '../simulation/flowPulse/watershed/watershedReportModel';

interface Matcher {
  readonly row: readonly [en: string, es: string];
  readonly names: readonly string[];
  /** Shortest-first, then longest-first phrases: a phrase can hold its neighbour's separator. */
  readonly res: readonly RegExp[];
  readonly weight: number;
  readonly copied: number;
}

const PARAM = /\{(\w+)\}/g;
const FIGURE = '(-?\\d[\\d,]*(?:\\.\\d+)?(?:e[-+]?\\d+)?)';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isPhrase = (name: string): boolean => /^[tuw]_/.test(name);

const EXACT = new Map<string, string>();
const MATCHERS: Matcher[] = [];
for (const row of DRAINAGE_SHEET_ROWS) {
  const names = [...row[0].matchAll(PARAM)].map((m) => m[1]!);
  if (names.length === 0) { EXACT.set(row[0], row[1]); continue; }
  const source = (phrase: string): string => row[0].split(/(\{\w+\})/)
    .map((part, i) => (i % 2 === 0 ? escapeRe(part) : isPhrase(part.slice(1, -1)) ? phrase : FIGURE)).join('');
  MATCHERS.push({
    row, names,
    res: ['(.+?)', '(.+)'].map((q) => new RegExp(`^${source(q)}$`, 's')),
    weight: row[0].replace(PARAM, '').length,
    copied: names.filter((n) => n.startsWith('u_') || n.startsWith('w_')).length,
  });
}
// The most literal row first; between equals, the one that copies the least.
MATCHERS.sort((a, b) => b.weight - a.weight || a.copied - b.copied);

export interface DrainageWords {
  /** An English line or label in the export language. */
  line(text: string): string;
  /** A figure written with a point, in the number style. */
  num(text: string): string;
}

export function drainageWords(loc: ReportLocale, onMiss?: (text: string) => void): DrainageWords {
  const num = (s: string): string => restyleNumbers(s, loc.numberStyle);
  if (loc.lang === 'en' && loc.numberStyle === 'point') return { line: (s) => s, num };
  const pick = (row: readonly [string, string]): string => row[loc.lang === 'es' ? 1 : 0];
  /** The template with its own constants restyled; figures in a list are separated by "; " where a comma is the decimal mark. */
  const template = (row: readonly [string, string]): string => {
    const text = pick(row);
    if (loc.numberStyle === 'point') return text;
    return num(text.replace(/(\{[a-z]\}[^{},;.:]*), (?=(?:C )?\{[a-z]\})/g, '$1; ').replace('(0, 0)', '(0; 0)'));
  };
  function find(text: string): string | null {
    if (EXACT.has(text)) return template([text, EXACT.get(text)!]);
    for (const m of MATCHERS) for (const re of m.res) {
      const got = re.exec(text);
      if (!got) break;
      const params: Record<string, string> = {};
      let ok = true;
      m.names.forEach((name, i) => {
        const value = got[i + 1]!;
        if (!isPhrase(name)) { params[name] = num(value); return; }
        const kind = name[0];
        const inner = kind === 'u' ? value : kind === 'w' ? (EXACT.has(value) ? find(value) : value) : find(value);
        if (inner === null) ok = false; else params[name] = inner;
      });
      if (ok) return fill(template(m.row), params, m.row[0]);
    }
    return null;
  }
  return {
    num,
    line: (text) => {
      // A section mark, list mark or indent belongs to the layout, not to the sentence.
      const mark = /^(?:# |- | +)/.exec(text)?.[0] ?? '';
      const body = text.slice(mark.length);
      if (body === '') return text;
      const got = find(body);
      if (got === null) onMiss?.(body);
      return mark + (got ?? body);
    },
  };
}
