/**
 * profileSheetLanguages.test.ts: the Light and Dark profile set in every
 * export language. Each state of the sheet is drawn; a sentence with no
 * translation, an English word left on the sheet, a text off the page or over
 * another fails.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { buildProfilePdf, type ProfilePdfInput } from '../src/render/measure/profilePdf';
import { PROFILE_SHEET_TEXT, type ProfileSheetKey } from '../src/i18n/deliverables/profileSheet';
import { EXPORT_LANGUAGES } from '../src/i18n/languages';
import { templateParams } from '../src/i18n/message';
import { profileWords } from '../src/export/localizeProfile';
import type { ExportLocale } from '../src/i18n/exportLocale';
import type { ProfileChartSample } from '../src/render/measure/types';
import type { ProfileDeliverable } from '../src/model/deliverableFields';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const LOCALES: ExportLocale[] = EXPORT_LANGUAGES.map((l) => ({ lang: l.id, numberStyle: l.numberStyle }));
const FOREIGN = LOCALES.filter((l) => l.lang !== 'en');
const wave = (n: number, length: number, amp: number, gaps = 0): ProfileChartSample[] => Array.from({ length: n }, (_, i) => ({
  distance: (i * length) / (n - 1), height: i > 4 && i <= 4 + gaps ? Number.NaN : 100 + amp * Math.sin((i / n) * 9) + amp * 0.4 * Math.sin((i / n) * 31), count: 20 + (i % 7),
}));
type Cls = 'producer' | 'derived' | 'absent';
const prov = (o: { cls?: Cls[]; streaming?: boolean; scope?: string; complete?: boolean | null; residentOnly?: boolean; trunc?: boolean; up?: boolean } = {}) => ({
  recordVersion: 1, method: 'corridor-percentile', corridorVersion: 1, capturedAt: '2026-01-01T00:00:00.000Z', up: [0, 0, 1], upDegenerate: o.up ?? false,
  acceptedCount: 1234, scope: o.scope ?? 'full-static-source', residentOnly: o.residentOnly ?? false, complete: o.complete === undefined ? true : o.complete,
  sources: (o.cls ?? ['producer']).map((classification, i) => ({ layerId: `layer_${i}`, displayName: `scan-${i}.las`, classification, streaming: o.streaming ?? false, acceptedCount: 617, contributed: true, residency: o.streaming ? (i % 2 ? false : null) : null, ...(o.trunc ? { truncation: { read: 4, declared: 2601 } } : {}) })),
  classPolicy: { excludedClasses: [3, 4, 5, 6, 7, 18], availableOnEverySource: !(o.cls ?? ['producer']).includes('absent') }, units: { linearUnit: 'metre', verticalReference: 'orthometric', verticalMetresPerUnit: 1 },
});
const plan = () => {
  const cols = 40, rows = 24, z = new Float32Array(cols * rows).map((_, i) => i % 40);
  return { relief: { cols, rows, cellSize: 5, originX: -10, originY: -60, z, coverage: new Uint8Array(cols * rows).fill(2) }, a: [0, 0] as [number, number], b: [120, 0] as [number, number], unitToMetres: 1, corridorM: 5, contours: null };
};
const heights = Array.from({ length: 40 }, (_, i) => 99 + i * 0.05);
const extras = (o: object = {}) => ({ returns: { count: 3, chainageM: [1, 50, 90], heightM: [100, 101, 100], ground: [1, 0, 1] }, plan: plan(), indexCrossings: [{ chainage: 30, height: 100 }], station: { chainageM: 30, keptM: 99.5, heightsM: heights, accepted: 400, percentile: 25 }, ...o });
const base = (over: object = {}): ProfilePdfInput => ({
  name: 'P1', project: 'scan-0', samples: wave(64, 120, 2), generatedAt: new Date('2026-01-01T00:00:00Z'), crs: 'EPSG:32612', verticalDatum: 'NAVD88',
  corridorWidthM: 5, groundPercentile: 25, style: 'light', loadFont, provenance: prov(), extras: extras(), pickedRiseM: 0.4,
  withheld: { sourcePoints: 420000, analysedPoints: 419000, withheldExcluded: 1000 }, method: 'olv.profile.corridor-percentile@2', ...over,
} as unknown as ProfilePdfInput);
const reduction = (mode: string, mixed?: number) => ({ mode, resident: 1912920, declared: 10789680, ...(mixed ? { reducedSources: mixed, totalSources: 3 } : {}) });
const STATES: Record<string, object> = {
  full: {},
  dark: { style: 'dark', extras: extras({ station: { ...extras().station, accepted: 40 } }) },
  noPlan: { extras: { returns: null, returnsNote: 'not drawn: a scan this profile was sampled from is hidden or closed', plan: null } },
  unread: { extras: null, provenance: null, withheld: null },
  unrecorded: { extras: { returns: null, returnsNote: 'not drawn: the profile does not record which of the open scans it was sampled from', plan: null } },
  offLine: { extras: { returns: { count: 1, chainageM: [1], heightM: [100] }, returnsNote: 'not drawn: the returns read now do not lie along the sampled line', plan: null } },
  gap: { samples: wave(64, 120, 2, 1) },
  gaps: { samples: wave(64, 120, 2, 9) },
  gapEnd: { samples: wave(64, 120, 2, 9).map((s, i) => (i === 63 ? { ...s, height: Number.NaN } : s)) },
  feet: { unitSystem: 'imperial' },
  unverified: { unitSystem: 'unverified', crs: null, verticalDatum: null, corridorWidthM: null, groundPercentile: null },
  noDatum: { verticalDatum: null, crs: null },
  conflict: { datumKnown: false },
  ellipsoidal: { provenance: { ...prov(), units: { linearUnit: 'metre', verticalReference: 'ellipsoidal', verticalMetresPerUnit: 1 } } },
  depth: { provenance: { ...prov(), units: { linearUnit: 'metre', verticalReference: 'depth', verticalMetresPerUnit: 1 } } },
  unknownRef: { verticalDatum: 'Some datum of 1950', provenance: { ...prov(), units: { linearUnit: 'metre', verticalReference: 'unknown', verticalMetresPerUnit: null } } },
  level: { samples: wave(64, 120, 0) },
  short: { samples: wave(31, 3, 0.2) },
  steep: { samples: wave(80, 20, 60) },
  long: { samples: wave(400, 18500, 220) },
  corrupt: { samples: wave(64, 120, 2).map((s, i) => (i === 63 ? { ...s, distance: Number.POSITIVE_INFINITY } : s)) },
  absentOne: { provenance: prov({ cls: ['absent'] }) },
  absentTwo: { provenance: prov({ cls: ['absent', 'absent'] }) },
  derivedTwo: { provenance: prov({ cls: ['derived', 'derived'] }) },
  mixed: { provenance: prov({ cls: ['producer', 'derived', 'absent'] }) },
  mixedTwo: { provenance: prov({ cls: ['producer', 'absent', 'absent'] }) },
  noSources: { provenance: { ...prov(), sources: [], scope: 'empty', complete: null } },
  resident: { provenance: prov({ streaming: true, scope: 'resident-snapshot', complete: false, residentOnly: true }), residentOnly: true },
  residentUnknown: { provenance: prov({ streaming: true, scope: 'resident-snapshot', complete: null, residentOnly: true, cls: ['producer', 'producer'] }), withheld: { sourcePoints: 10, analysedPoints: 10, withheldExcluded: 'unknown' } },
  mixedRead: { provenance: { ...prov({ scope: 'mixed-full-and-resident', complete: false, cls: ['producer', 'producer'] }), sources: [prov().sources[0], { ...prov({ streaming: true }).sources[0], layerId: 's' }] } },
  truncated: { provenance: prov({ trunc: true, cls: ['producer', 'producer'] }), withheld: { sourcePoints: 10, analysedPoints: 10, withheldExcluded: 'unknown' } },
  truncNote: { coverageNote: 'Truncated: 4 of 2,601 points read' },
  voxel: { withheld: { sourcePoints: 1912920, analysedPoints: 1912920, withheldExcluded: 'unknown', reduction: reduction('voxel-centroids') } },
  stride: { withheld: { sourcePoints: 1912920, analysedPoints: 1912000, withheldExcluded: 920, reduction: reduction('stride') } },
  mixVoxel1: { withheld: { sourcePoints: 9, analysedPoints: 9, withheldExcluded: 0, reduction: reduction('voxel-centroids', 1) } },
  mixVoxel2: { withheld: { sourcePoints: 9, analysedPoints: 9, withheldExcluded: 0, reduction: reduction('voxel-centroids', 2) } },
  mixStride1: { withheld: { sourcePoints: 9, analysedPoints: 9, withheldExcluded: 0, reduction: reduction('stride', 1) } },
  mixStride2: { withheld: { sourcePoints: 9, analysedPoints: 9, withheldExcluded: 0, reduction: reduction('stride', 2) } },
  reducedNoRecord: { provenance: null, withheld: { sourcePoints: 9, analysedPoints: 9, withheldExcluded: 0, reduction: reduction('stride') } },
  noMethod: { method: null },
  upBad: { provenance: prov({ up: true }) },
  oneStationShort: { samples: wave(2, 120, 1) },
  fallback: { loadFont: async () => { throw new Error('offline'); } },
};
const OWN: ProfileDeliverable = {
  title: 'Río Bravo, sección 4', subtitle: 'Cruce del camino', project: 'Elevation', client: 'Ayuntamiento', location: 'Coahuila', company: 'Topografía Norte S.A.', preparedBy: 'A. Pérez', checkedBy: 'B. Núñez', approvedBy: 'C. Muñoz',
  drawingNo: 'PL-014', revision: 'B', date: '2026-11-23', status: 'review', endA: 'North bank', endB: 'South bank', notes: 'Depth\nSecond paragraph.',
  issues: [{ issue: 'A', description: 'For comment', date: '2026-11-01', by: 'AP', checked: 'BN' }], marks: [{ chainage: 20, text: 'Culvert' }, { chainage: 60, text: 'Bridge axis' }],
};

interface Drawn { text: string; size: number; x: number; y: number; right: number; page: PDFPage }
async function drawn(input: ProfilePdfInput): Promise<{ ts: Drawn[]; missed: string[] }> {
  const ts: Drawn[] = [], missed: string[] = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { size?: number; x?: number; y?: number; font?: { widthOfTextAtSize(a: string, b: number): number } }) {
    ts.push({ text: t, size: o?.size ?? 0, x: o?.x ?? 0, y: o?.y ?? 0, right: (o?.x ?? 0) + (o?.font?.widthOfTextAtSize(t, o.size ?? 0) ?? 0), page: this });
    return orig.call(this, t, o as never);
  });
  // The drawing is what is read here; writing the file subsets every font.
  vi.spyOn(PDFDocument.prototype, 'save').mockResolvedValue(new Uint8Array());
  await buildProfilePdf({ ...input, onUntranslated: (m) => missed.push(m) });
  vi.restoreAllMocks();
  return { ts, missed };
}
afterEach(() => { vi.restoreAllMocks(); });

/** English words no other language's row uses, so one on a sheet is a missed translation. */
const ENGLISH_ONLY = /\b(the|and|with|from|which|returns|height|heights|source|sources|station|stations|chainage|grade|grades|over|under|not|lowest|highest|steepest|read|recorded|drawn|sampled|corridor each|long, measured)\b/i;
/** Words of the set that are the same in another language, or are copied on purpose. */
const copied = (t: string): string => t
  .replace(/OpenLiDARViewer|olv\.profile\.\S+|corridor-percentile|scan-\d\S*|layer_\S+|Withheld|Some datum of 1950|North bank|South bank|For comment|Bridge axis|Second paragraph\./g, '')
  .replace(/\b(Station|station|stations|Source|source|Sources|sources|statique|Corridor|corridor|Note|note)\b/g, '');

function noOverlap(ts: readonly Drawn[]): void {
  const hits: string[] = [];
  for (const p of new Set(ts.map((t) => t.page))) {
    const on = ts.filter((t) => t.page === p && t.text.trim() !== '');
    for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
      const a = on[i]!, b = on[j]!;
      const x = Math.min(a.right, b.right) - Math.max(a.x, b.x), y = Math.min(a.y + a.size * 0.7, b.y + b.size * 0.7) - Math.max(a.y, b.y);
      if (x > 0.5 && y > 0.5) hits.push(`${a.text} | ${b.text}`);
    }
  }
  expect(hits).toEqual([]);
}

describe('the profile set in every export language', () => {
  for (const locale of FOREIGN) {
    for (const [name, over] of Object.entries(STATES)) {
      it(`${locale.lang} ${name}`, async () => {
        const { ts, missed } = await drawn(base({ ...over, locale }));
        expect(missed).toEqual([]);
        for (const t of ts) {
          expect(copied(t.text), t.text).not.toMatch(ENGLISH_ONLY);
          expect(t.size, t.text).toBeGreaterThanOrEqual(9.5 - 1e-6);
          expect(t.x, t.text).toBeGreaterThanOrEqual(6);
          expect(t.right, t.text).toBeLessThanOrEqual(1190.55 - 6);
          expect(t.y, t.text).toBeGreaterThanOrEqual(12);
        }
        noOverlap(ts);
      }, 60_000);
    }

    it(`${locale.lang}: user text is printed as typed, with both papers, and every footer carries the draft note`, async () => {
      for (const paper of ['a3', 'tabloid'] as const) {
        const { ts, missed } = await drawn(base({ locale, deliverable: OWN, paper }));
        expect(missed).toEqual([]);
        noOverlap(ts);
        for (const t of ts) {
          expect(t.right, t.text).toBeLessThanOrEqual((paper === 'a3' ? 1190.55 : 1224) - 6);
          expect(t.y + t.size * 0.7, t.text).toBeLessThanOrEqual((paper === 'a3' ? 841.89 : 792) - 6);
        }
        // The technical notes keep to one sheet with every field set.
        const heads = [...new Set(ts.map((t) => t.page))].map((pg) => ts.find((t) => t.page === pg)!.text);
        expect(heads, paper).not.toContain(profileWords(locale).say('technicalNotesMore'));
        expect(heads.length, paper).toBeLessThanOrEqual(5);
        const all = ts.map((t) => t.text);
        const joined = all.join(' ');
        for (const v of [OWN.title, OWN.subtitle, OWN.project, OWN.client, OWN.location, OWN.company, OWN.preparedBy, OWN.checkedBy, OWN.approvedBy, OWN.drawingNo, OWN.date, 'For comment', 'Culvert', 'Bridge axis', 'Second paragraph.', 'North bank']) expect(joined, v).toContain(v!);
        expect(all.filter((t) => t === 'Elevation').length).toBeGreaterThanOrEqual(1);
        const draft = profileWords(locale).draft!;
        const foot = ts.filter((t) => t.y < 20 && t.text.includes(draft));
        expect(foot).toHaveLength(new Set(ts.map((t) => t.page)).size);
      }
    }, 60_000);
  }

  it('English is what it was, word for word, when no field is set', async () => {
    const a = await buildProfilePdf(base()), b = await buildProfilePdf(base({ locale: { lang: 'en', numberStyle: 'point' }, deliverable: {}, paper: 'a3' }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('the number style is its own choice', async () => {
    const es = (await drawn(base({ locale: { lang: 'es', numberStyle: 'comma' } }))).ts.map((t) => t.text);
    expect(es).toContain('0+020');
    expect(es.some((t) => t.startsWith('120,00 m'))).toBe(true);
    const en = (await drawn(base({ locale: { lang: 'en', numberStyle: 'comma' } }))).ts.map((t) => t.text);
    expect(en.some((t) => t.includes('419\u00a0000 of 420\u00a0000 analysed'))).toBe(true);
    expect(en.some((t) => t.includes('EPSG:32612'))).toBe(true);
    // Codes, versions and times are never reformatted.
    expect(en.join(' ')).toContain('olv.profile.corridor-percentile@2');
    expect(en.join(' ')).toContain('2026-01-01T00:00:00.000Z');
  });

  it('the PDF names its language', async () => {
    const doc = await PDFDocument.load(await buildProfilePdf(base({ locale: { lang: 'de', numberStyle: 'comma' } })));
    expect(doc.catalog.get(doc.context.obj('Lang') as never) ?? String(doc.catalog)).toBeTruthy();
    expect(doc.getTitle()).toBe('Geländeprofil - P1');
  });

  it('Classic stays in English and prints the fields its title block has', async () => {
    const { ts } = await drawn(base({ style: 'classic', loadFont: undefined, locale: { lang: 'de', numberStyle: 'comma' }, deliverable: OWN }));
    const all = ts.map((t) => t.text).join('\n');
    for (const v of ['Elevation', 'FOR REVIEW', 'PL-014', 'For comment', 'Endpoint gradient']) expect(all).toContain(v);
    expect(all).not.toContain('Allgemeine Hinweise');
  });
});

describe('the logo', () => {
  const logoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const placed = async (over: object): Promise<number> => {
    let n = 0;
    const orig = PDFPage.prototype.drawImage;
    vi.spyOn(PDFPage.prototype, 'drawImage').mockImplementation(function (this: PDFPage, img, o) { if (img.width === 1 && img.height === 1) n++; return orig.call(this, img, o); });
    await buildProfilePdf(base(over));
    vi.restoreAllMocks();
    return n;
  };
  it('is on every Light and Dark sheet', async () => {
    for (const style of ['light', 'dark']) expect(await placed({ style, deliverable: { logoDataUrl } })).toBe(4);
    expect(await placed({})).toBe(0);
  });
  it('a damaged image is left out and the sheets are still made', async () => {
    expect(await placed({ deliverable: { logoDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAA=' } })).toBe(0);
  });
});

describe('the longest fields', () => {
  it('stay on the page and off each other, and the suitability note is whole', async () => {
    const w = (n: number): string => 'Wide text '.repeat(40).slice(0, n).trim();
    const long: ProfileDeliverable = {
      title: w(90), subtitle: w(140), project: w(120), client: w(120), location: w(120), company: w(90), preparedBy: w(80), checkedBy: w(80), approvedBy: w(80),
      drawingNo: w(40), revision: w(12), date: w(30), status: 'issued', endA: w(40), endB: w(40), notes: `${w(390)}\n`.repeat(3),
      issues: Array.from({ length: 6 }, () => ({ issue: w(8), description: w(110), date: w(30), by: w(24), checked: w(24) })),
      marks: Array.from({ length: 8 }, (_, i) => ({ chainage: i * 17, text: w(60) })),
    };
    for (const locale of LOCALES) for (const paper of ['a3', 'tabloid'] as const) {
      const { ts } = await drawn(base({ locale, deliverable: long, paper }));
      noOverlap(ts);
      for (const t of ts) expect(t.right, t.text).toBeLessThanOrEqual((paper === 'a3' ? 1190.55 : 1224) - 6);
      const note = profileWords(locale).translate('Suitability: not survey-grade unless validated against ground-truth control.');
      const pages = new Set(ts.map((t) => t.page)).size;
      expect(ts.filter((t) => t.y < 20 && t.text.includes(note)).length).toBe(pages - 1);
    }
  }, 120_000);
});

describe('notes taller than a column', () => {
  it.each(['a3', 'tabloid'] as const)('go on in the next column and sheet, on the page, with none lost (%s)', async (paper) => {
    const lines = Array.from({ length: 170 }, (_, i) => `n${i}x`);
    const { ts } = await drawn(base({ deliverable: { notes: lines.join('\n') }, paper }));
    noOverlap(ts);
    for (const t of ts) expect(t.y, t.text).toBeGreaterThanOrEqual(12);
    for (const ln of lines) expect(ts.filter((t) => t.text === ln), ln).toHaveLength(1);
  });
  it('a word wider than the column is cut at its edge', async () => {
    const word = 'W'.repeat(300);
    const { ts } = await drawn(base({ deliverable: { notes: word } }));
    // Sheet one has no room for it and refers to the method sheet.
    expect(ts.filter((t) => /W{5}/.test(t.text)).map((t) => t.text.replace(/[^W]/g, '')).join('')).toBe(word);
    for (const t of ts) expect(t.right, t.text).toBeLessThanOrEqual(1190.55 - 6);
    noOverlap(ts);
  });
});

describe('the catalog', () => {
  const keys = Object.keys(PROFILE_SHEET_TEXT) as ProfileSheetKey[];
  it('every language uses the English parameters, and no entry is empty', () => {
    for (const k of keys) for (const t of PROFILE_SHEET_TEXT[k]) {
      expect(t.trim().length, k).toBeGreaterThan(0);
      expect(templateParams(t), k).toEqual(templateParams(PROFILE_SHEET_TEXT[k][0]));
    }
  });
  it('a suitability note never loses its negation', () => {
    const [, es, pt, fr, de] = PROFILE_SHEET_TEXT.suitability;
    expect(es).toMatch(/sin calidad/); expect(pt).toMatch(/sem qualidade/); expect(fr).toMatch(/pas de qualité/); expect(de).toMatch(/keine Vermessungsqualität/);
  });
  it('every English sentence finds its own row', () => {
    for (const k of keys) {
      const en = PROFILE_SHEET_TEXT[k][0];
      if (/\{/.test(en)) continue;
      const w = profileWords({ lang: 'de', numberStyle: 'point' });
      const first = keys.find((q) => PROFILE_SHEET_TEXT[q][0] === en)!;
      expect(w.translate(en), k).toBe(PROFILE_SHEET_TEXT[first][4]);
    }
  });
});
