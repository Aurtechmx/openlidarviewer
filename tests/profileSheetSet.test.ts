/**
 * profileSheetSet.test.ts: the Light and Dark profile set reads at arm's
 * length, keeps every caveat on every sheet, and draws one station only when
 * its returns give back the height the profile recorded.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFPage, PDFDocument } from 'pdf-lib';
import { buildProfilePdf, type ProfilePdfInput } from '../src/render/measure/profilePdf';
import { PROFILE_TYPE, profilePalette } from '../src/render/measure/profileSheetPalette';
import { contrastRatio, type SheetRgb } from '../src/export/sheetKit/tokens';
import { stationReturns } from '../src/app/profileSheetExtras';
import { chooseProfileScales, standardScaleAtLeast, verticalScaleStatement } from '../src/render/measure/profileSheetLayout';
import type { ProfileChartSample } from '../src/render/measure/types';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const wave = (n: number, length: number, amp: number, gap = false): ProfileChartSample[] => Array.from({ length: n }, (_, i) => ({
  distance: (i * length) / (n - 1), height: gap && i % 23 > 18 ? Number.NaN : 100 + amp * Math.sin((i / n) * 9) + amp * 0.4 * Math.sin((i / n) * 31), count: 20 + (i % 7),
}));
const provenance = (k: number) => ({
  recordVersion: 1, method: 'corridor-percentile', corridorVersion: 1, capturedAt: '2026-01-01T00:00:00.000Z', up: [0, 0, 1], upDegenerate: false,
  acceptedCount: 10, scope: 'full-static-source', residentOnly: false, complete: true,
  sources: Array.from({ length: k }, (_, i) => ({ layerId: `layer_8236755b-6377-4750-b018-bb3a1c2d3e4${i}`, displayName: `a-rather-long-scan-file-name-${i}.las`, classification: 'producer', streaming: false, acceptedCount: 10, contributed: true, residency: null })),
  classPolicy: { excludedClasses: [3, 5], availableOnEverySource: true }, units: { linearUnit: 'metre', verticalReference: 'orthometric', verticalMetresPerUnit: 1 },
});
const base = (over: Partial<ProfilePdfInput> = {}): ProfilePdfInput => ({
  name: 'Profile 1', project: 'Site', samples: wave(64, 120, 2), generatedAt: new Date('2026-01-01T00:00:00Z'), crs: 'EPSG:32612', verticalDatum: 'NAVD88',
  corridorWidthM: 5, groundPercentile: 25, style: 'light', loadFont, ...over,
});
interface Drawn { text: string; size: number; x: number; y: number; right: number; page: PDFPage }
async function drawn(input: ProfilePdfInput): Promise<Drawn[]> {
  const out: Drawn[] = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { size?: number; x?: number; y?: number; font?: { widthOfTextAtSize(a: string, b: number): number } }) {
    out.push({ text: t, size: o?.size ?? 0, x: o?.x ?? 0, y: o?.y ?? 0, right: (o?.x ?? 0) + (o?.font?.widthOfTextAtSize(t, o.size ?? 0) ?? 0), page: this });
    return orig.call(this, t, o as never);
  });
  await buildProfilePdf(input);
  vi.restoreAllMocks();
  return out;
}
afterEach(() => { vi.restoreAllMocks(); });

const CASES: Record<string, Partial<ProfilePdfInput>> = {
  plain: {},
  dark: { style: 'dark' },
  gaps: { samples: wave(120, 300, 12, true) },
  feet: { unitSystem: 'imperial' },
  unverified: { unitSystem: 'unverified' },
  short: { samples: wave(31, 3, 0.2) },
  cliff: { samples: wave(80, 20, 60) },
  level: { samples: wave(80, 120, 0) },
  long: { samples: wave(400, 18_500, 220), name: 'A very long profile name that goes on past the width the sheet has for it, twice over', project: 'a-very-long-scan-file-name-that-never-seems-to-end-classified-projected-clipped.laz', provenance: provenance(24) as never, coverageNote: 'Truncated: 4 of 2,601 points read', datumKnown: false },
  fallback: { loadFont: async () => { throw new Error('offline'); } },
};

describe('the styled profile set', () => {
  for (const [name, over] of Object.entries(CASES)) {
    it(`${name}: nothing is set below ${PROFILE_TYPE.small} pt or off the page, and no two texts overlap`, async () => {
      const ts = await drawn(base(over));
      expect(ts.length).toBeGreaterThan(60);
      for (const t of ts) {
        expect(t.size, t.text).toBeGreaterThanOrEqual(PROFILE_TYPE.small - 1e-6);
        expect(t.x, t.text).toBeGreaterThanOrEqual(8);
        expect(t.right, t.text).toBeLessThanOrEqual(1190.55 - 8);
        expect(t.y, t.text).toBeGreaterThanOrEqual(12);
      }
      const pages = [...new Set(ts.map((t) => t.page))];
      for (const p of pages) {
        const on = ts.filter((t) => t.page === p && t.text.trim() !== '');
        for (let i = 0; i < on.length; i++) for (let j = i + 1; j < on.length; j++) {
          const a = on[i]!, b = on[j]!;
          const x = Math.min(a.right, b.right) - Math.max(a.x, b.x), y = Math.min(a.y + a.size * 0.7, b.y + b.size * 0.7) - Math.max(a.y, b.y);
          expect(x > 0.5 && y > 0.5, `${a.text} | ${b.text}`).toBe(false);
        }
      }
      // Every sheet after the first carries the status and the whole suitability note in its footer.
      const foot = ts.filter((t) => t.y < 20 && t.text.startsWith('PRELIMINARY'));
      expect(foot).toHaveLength(pages.length - 1);
      for (const f of foot) expect(f.text).toContain('not survey-grade unless validated against ground-truth control.');
    }, 120_000);
  }

  it('prints every general note in full on the method sheet, and each group of technical notes once', async () => {
    const ts = await drawn(base({ provenance: provenance(1) as never, pickedRiseM: 0.4 }));
    for (const g of ['Geometry', 'Grade', 'Sampling', 'Reference', 'General notes', 'Issues']) expect(ts.filter((t) => t.text === g), g).toHaveLength(1);
    const method = ts.filter((t) => t.page === ts.find((q) => q.text === 'Method and sources')!.page).map((t) => t.text).join(' ');
    for (const w of ['Estimated, not measured.', 'Vertical reference:', 'Provenance:', 'Points:', 'Suitability:']) expect(method).toContain(w);
  }, 60_000);

  it('a source table cell that is too wide is cut in the middle, so both ends of an id show', async () => {
    const ts = await drawn(base({ provenance: provenance(1) as never }));
    const id = ts.find((t) => t.text.startsWith('layer_'))!.text;
    expect(id).toMatch(/^layer_8236.*\.\.\..*e40$|^layer_8236755b-6377-4750-b018-bb3a1c2d3e40$/);
  }, 60_000);

  it('a level line marks no high, low or steep place', async () => {
    const ts = (await drawn(base({ samples: wave(80, 120, 0) }))).map((t) => t.text);
    expect(ts.some((t) => /^(Highest|Lowest) \d|^Steepest over/.test(t))).toBe(false);
  }, 60_000);

  it('is deterministic and leaves Classic as it was', async () => {
    const classic = base({ style: 'classic', loadFont: undefined });
    const before = Buffer.from(await buildProfilePdf(classic));
    const a = Buffer.from(await buildProfilePdf(base())), b = Buffer.from(await buildProfilePdf(base()));
    expect(a.equals(b)).toBe(true);
    expect(Buffer.from(await buildProfilePdf(classic)).equals(before)).toBe(true);
    expect((await PDFDocument.load(a)).getPageCount()).toBe(4);
  }, 60_000);
});

describe('the palette', () => {
  for (const style of ['light', 'dark'] as const) {
    it(`${style}: text reads at 4.5:1 on every ground it is set on`, () => {
      const p = profilePalette(style);
      const pairs: Array<[string, SheetRgb, SheetRgb]> = [
        ['ink on paper', p.ink, p.paper], ['dim on paper', p.dim, p.paper], ['warn on paper', p.warn, p.paper],
        ['ink on the ground', p.ink, p.earth], ['ink on the base', p.ink, p.base], ['dim on the base', p.baseDim, p.base], ['steep figure', p.hotInk, p.hot],
      ];
      for (const [n, a, b] of pairs) expect(contrastRatio(a, b), n).toBeGreaterThanOrEqual(4.5);
      for (const [n, a, b] of [['line on paper', p.surface, p.paper], ['line on the ground', p.surface, p.earth], ['ground returns', p.groundDot, p.paper], ['other returns', p.otherDot, p.paper], ['bars', p.solid, p.base]] as const) {
        expect(contrastRatio(a, b), n).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe('scales', () => {
  it('the styled steps fill more of the width, and Classic keeps the standard ones', () => {
    const req = { lengthM: 120, minM: 0, maxM: 4, plotWpt: 954, plotHpt: 300, k: 1 };
    expect(chooseProfileScales(req).horizontal).toBe(500);
    expect(chooseProfileScales({ ...req, denominators: [100, 200, 300, 400, 500] }).horizontal).toBe(400);
    expect(standardScaleAtLeast(357)).toBe(500);
  });
  it('a strong compression is not rounded to nothing', () => {
    expect(verticalScaleStatement(0.0375)).toContain('0.037:1');
    expect(verticalScaleStatement(0.6)).toContain('0.6:1');
  });
});

describe('stationReturns', () => {
  const raw: ProfileChartSample[] = [0, 1, 2, 3].map((d) => ({ distance: d, height: d === 2 ? 11.75 : 10, count: 8 }));
  const hs = [10, 11, 12, 13, 14, 15, 16, 17];
  const pts = (over: { heights?: number[]; classes?: number[] } = {}) => {
    const h = over.heights ?? hs;
    return { count: h.length, chainage: h.map(() => 2.1), height: h, classification: over.classes ?? null };
  };
  it('gives the returns when their percentile is the recorded height', () => {
    const r = stationReturns(raw, 2, 25, pts(), () => true)!;
    expect(r.kept).toBeCloseTo(11.75, 9);
    expect([...r.heights]).toEqual(hs);
  });
  it('gives nothing when it is not, when the count differs, or when a return of another scan is needed', () => {
    expect(stationReturns(raw, 2, 50, pts(), () => true)).toBeNull();
    expect(stationReturns(raw, 2, 25, pts({ heights: [...hs, 11.75] }), () => true)).toBeNull();
    expect(stationReturns(raw, 2, 25, pts(), (i) => i > 0)).toBeNull();
    expect(stationReturns(raw, 1, 25, pts(), () => true)).toBeNull();
  });
  it('leaves out the classes the sampler leaves out', () => {
    expect(stationReturns(raw, 2, 25, pts({ heights: [...hs, 30], classes: [2, 2, 2, 2, 2, 2, 2, 1, 5] }), () => true)?.heights).toHaveLength(8);
  });
});
