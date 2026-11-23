/**
 * localizeCard.ts: the Studio image card in the export language.
 *
 * The card's rows are written in English by the exporters. This turns them
 * into the export language as the card is drawn: exact text from the
 * catalog, text with figures in it by template, and numbers in the export's
 * number style. English with point decimals is returned as it came, so an English card is
 * unchanged. Text with no entry stays in English; a test runs every exporter
 * so that does not happen for anything the card can print.
 */
import { STUDIO_CARD_TEXT, type CardCatalog, type CardExactKey, type CardTemplateKey } from '../i18n/deliverables/studioCard';
import { languageInfo } from '../i18n/languages';
import type { ExportLocale } from '../i18n/exportLocale';
import { restyleNumbers } from '../i18n/numberStyle';
import type { ScanReportData, ScanReportRow } from './ScanReportRenderer';

const ENGLISH = STUDIO_CARD_TEXT.en;

/** Rows whose values are names or encodings, never reformatted as numbers. */
const VERBATIM_ROWS = new Set(['CRS', 'Capture', 'Class filter', 'Encoding', 'Mode', 'Palette', 'Overlay']);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for an English template: `{name}` parts become captures. */
function templateRe(template: string): { re: RegExp; names: string[] } {
  const names: string[] = [];
  const pattern = template.split(/(\{\w+\})/).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    if (!m) return escapeRe(part);
    names.push(m[1]);
    // Greedy: a capture-type name can hold parentheses of its own, and only
    // the last "(...)" is the confidence.
    return '(.*)';
  }).join('');
  return { re: new RegExp(`^${pattern}$`, 's'), names };
}

const MATCHERS = Object.fromEntries(
  (Object.keys(ENGLISH.templates) as CardTemplateKey[]).map((k) => [k, templateRe(ENGLISH.templates[k])]),
) as Record<CardTemplateKey, { re: RegExp; names: string[] }>;

function match(key: CardTemplateKey, text: string): Record<string, string> | null {
  const { re, names } = MATCHERS[key];
  const m = re.exec(text);
  if (!m) return null;
  return Object.fromEntries(names.map((n, i) => [n, m[i + 1]]));
}

function fillTemplate(cat: CardCatalog, key: CardTemplateKey, params: Record<string, string>): string {
  return cat.templates[key].replace(/\{(\w+)\}/g, (_, n: string) => params[n] ?? '');
}

function exact(cat: CardCatalog, text: string): string | null {
  return Object.hasOwn(ENGLISH.exact, text) ? cat.exact[text as CardExactKey] : null;
}

function label(cat: CardCatalog, text: string): string {
  const hit = exact(cat, text);
  if (hit !== null) return hit;
  for (const key of ['min', 'max', 'near', 'far', 'range'] as const) {
    const m = match(key, text);
    if (m) return fillTemplate(cat, key, m);
  }
  return text;
}

function unitWord(cat: CardCatalog, text: string): string {
  return text.replace(/\bunits\b/g, cat.exact.units);
}

/** A capture type: a known one, one the file declared (quoted as it is), or the text as it came. */
function captureType(cat: CardCatalog, text: string): string {
  const declared = match('declared', text);
  return exact(cat, text) ?? (declared ? fillTemplate(cat, 'declared', declared) : text);
}

function value(cat: CardCatalog, rowLabel: string, text: string): string {
  // A CRS is a name; only the app's own placeholders are words.
  if (rowLabel === 'CRS') return /^Unknown( CRS)?$/.test(text) ? exact(cat, text) ?? text : text;
  const hit = exact(cat, text);
  if (hit !== null) return hit;
  let m = match('displaySample', text);
  if (m) return fillTemplate(cat, 'displaySample', m);
  m = match('density', text);
  if (m) return fillTemplate(cat, 'density', { v: m.v, u: unitWord(cat, m.u) });
  for (const key of ['classified', 'unclassified'] as const) {
    m = match(key, text);
    if (m) return fillTemplate(cat, key, { pct: m.pct, basis: m.basis === ENGLISH.templates.basisSample ? cat.templates.basisSample : m.basis });
  }
  m = match('notGround', text);
  if (m) return fillTemplate(cat, 'notGround', { reason: exact(cat, m.reason) ?? m.reason });
  if (rowLabel === 'Capture') {
    m = match('capture', text);
    if (m) return fillTemplate(cat, 'capture', { label: captureType(cat, m.label), confidence: exact(cat, m.confidence) ?? m.confidence });
  }
  if (rowLabel === 'Class filter') return scopeStampIn(cat, text);
  m = match('unitsOf', text);
  if (m) return fillTemplate(cat, 'unitsOf', m);
  return unitWord(cat, text);
}

function scopeStampIn(cat: CardCatalog, text: string): string {
  const hit = exact(cat, text);
  if (hit !== null) return hit;
  // With every class hidden there are no names before the count.
  const none = match('scopeNone', text);
  if (none) return fillTemplate(cat, 'scopeNone', none);
  const m = match('scope', text);
  return m ? fillTemplate(cat, 'scope', m) : text;
}

/** The card in the export language; English comes back unchanged. */
export function localizeScanReport(data: ScanReportData, locale: ExportLocale): ScanReportData {
  if (locale.lang === 'en' && locale.numberStyle === 'point') return data;
  const cat = STUDIO_CARD_TEXT[locale.lang];
  const rows: ScanReportRow[] = data.rows.map((row) => {
    const translated = value(cat, row.label, row.value);
    return {
      ...row,
      label: label(cat, row.label),
      value: VERBATIM_ROWS.has(row.label) ? translated : restyleNumbers(translated, locale.numberStyle),
    };
  });
  const footer = languageInfo(locale.lang).reviewed ? data.footer : `${data.footer} · ${cat.templates.draft}`;
  return { ...data, title: exact(cat, data.title) ?? data.title, rows, footer };
}

/** The class-filter banner's text in the export language. */
export function classScopeBannerText(stamp: string, locale: ExportLocale): string {
  const cat = STUDIO_CARD_TEXT[locale.lang];
  const inLanguage = locale.lang === 'en' ? stamp : scopeStampIn(cat, stamp);
  return fillTemplate(cat, 'banner', { stamp: inLanguage });
}
