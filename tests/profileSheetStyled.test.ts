/**
 * profileSheetStyled.test.ts: the Light and Dark profile sheet, the figures
 * it draws, and the inputs the app builds for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { buildProfilePdf, type ProfilePdfInput } from '../src/render/measure/profilePdf';
import { countsPerStation, gradeSeries, indexCrossings, notesForRoom, profileInkFor } from '../src/render/measure/profileSheetStyled';
import { DEFAULT_PROFILE_IMAGE_THEME, profileImageThemeFor } from '../src/render/measure/profileSectionImage';
import { returnsAgree, sampleFrame } from '../src/app/profileSheetExtras';
import { sheetTokens } from '../src/export/sheetKit/tokens';
import type { ProfileChartSample } from '../src/render/measure/types';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const D = new Date('2026-01-01T00:00:00.000Z');

function samples(gap = true): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i <= 200; i++) {
    const d = i;
    const missing = gap && i > 80 && i < 90;
    out.push({ distance: d, height: missing ? Number.NaN : 100 + 0.3 * d + 4 * Math.sin(d / 17), count: missing ? 0 : 20 + (i % 5) });
  }
  return out;
}

function base(over: Partial<ProfilePdfInput> = {}): ProfilePdfInput {
  return { name: 'Profile A - B', project: 'Site', samples: samples(), generatedAt: D, crs: 'WGS 84 / UTM zone 12N', verticalDatum: 'NAVD88', corridorWidthM: 2, groundPercentile: 25, loadFont, ...over };
}

/** A small analysed-looking grid and contour set around the line for the plan strip. */
function plan() {
  const cols = 60, rows = 40;
  const z = new Float32Array(cols * rows), coverage = new Uint8Array(cols * rows).fill(2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) z[r * cols + c] = 100 + 0.3 * c * 5;
  const features = [110, 120, 130].map((v, i) => ({ value: v, isIndex: i % 2 === 0, grade: 'solid' as const, meanConfidence: 90, closed: false, coordinates: [[(v - 100) / 1.5, 0], [(v - 100) / 1.5, 200]] as Array<[number, number]> }));
  return {
    relief: { cols, rows, cellSize: 5, originX: 0, originY: 0, z, coverage },
    a: [0, 100] as [number, number], b: [200, 100] as [number, number], unitToMetres: 1,
    contours: { features, crs: null, verticalDatum: null, intervalM: 10, contourStyle: 'smooth', bbox: { minX: 0, minY: 0, maxX: 200, maxY: 200 }, interpolatedFraction: 0, coverageMode: 'full', warnings: [] } as never,
  };
}

function returns() {
  const n = 2000, ch = new Float32Array(n), h = new Float64Array(n), g = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const d = (i * 37) % 200; ch[i] = d; h[i] = 100 + 0.3 * d + 4 * Math.sin(d / 17) + (i % 4 === 0 ? 2 : 0); g[i] = i % 4 === 0 ? 0 : 1; }
  return { count: n, chainageM: ch, heightM: h, ground: g };
}

async function drawn(input: ProfilePdfInput): Promise<{ texts: string[]; bytes: Uint8Array }> {
  const texts: string[] = [];
  const orig = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, o?: object) {
    texts.push(text);
    return orig.call(this, text, o as never);
  });
  const bytes = await buildProfilePdf(input);
  return { texts, bytes };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('style dispatch', () => {
  it('Classic, or no style, is the drawing set as before, byte for byte', async () => {
    const plain = await buildProfilePdf(base({ loadFont: undefined }));
    expect(Buffer.from(await buildProfilePdf(base({ style: 'classic', extras: { returns: returns(), plan: plan() } }))).equals(Buffer.from(plain))).toBe(true);
  });

  for (const style of ['light', 'dark'] as const) {
    it(`${style}: deterministic, and the same number of sheets as Classic`, async () => {
      const a = await buildProfilePdf(base({ style, extras: { returns: returns(), plan: plan(), indexLevels: [110, 130] } }));
      const b = await buildProfilePdf(base({ style, extras: { returns: returns(), plan: plan(), indexLevels: [110, 130] } }));
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      const classic = await PDFDocument.load(await buildProfilePdf(base()));
      expect((await PDFDocument.load(a)).getPageCount()).toBe(classic.getPageCount());
    }, 120_000);
  }
});

describe('the styled sheet one', () => {
  it('prints the headline figures, the scale statement and every general note', async () => {
    const { texts } = await drawn(base({ style: 'light', extras: { returns: returns(), plan: plan(), indexLevels: [110, 130] } }));
    const all = texts.join('\n');
    for (const want of ['PROFILE', 'Profile A - B', 'LENGTH (M)', 'ENDPOINT GRADIENT (%)', 'STEEPEST OVER 10 M (%)', 'Vertical exaggeration', 'CHAINAGE', 'GRADE %']) {
      expect(all, want).toContain(want);
    }
    expect(all).toMatch(/Estimated, not measured/);
    expect(all).toMatch(/not survey-grade/i);
    expect(texts.filter((t) => /^SHEET 1 \/ \d+$/.test(t))).toHaveLength(1);
  }, 120_000);

  it('says the plan strip is left out when no terrain run gives a surface', async () => {
    const { texts } = await drawn(base({ style: 'light', extras: { returns: returns() } }));
    expect(texts.some((t) => t.includes('not drawn: no terrain run'))).toBe(true);
  }, 120_000);

  it('lists only what it draws in the legend', async () => {
    const withAll = (await drawn(base({ style: 'dark', extras: { returns: returns(), plan: plan(), indexLevels: [110] } }))).texts;
    expect(withAll).toEqual(expect.arrayContaining(['Ground returns', 'Other returns', 'Crosses an index contour', 'Profile line and corridor (plan)']));
    vi.restoreAllMocks();
    const bare = (await drawn(base({ style: 'dark', extras: null }))).texts;
    expect(bare).not.toContain('Ground returns');
    expect(bare).not.toContain('Crosses an index contour');
  }, 120_000);

  it('labels the chainage ticks of a short profile with the decimals the step needs', async () => {
    const short: ProfileChartSample[] = Array.from({ length: 31 }, (_, i) => ({ distance: i * 0.1, height: 100 + 0.05 * i, count: 20 }));
    const { texts } = await drawn(base({ style: 'light', samples: short, extras: null }));
    expect(texts).toEqual(expect.arrayContaining(['0.2', '1.0', '2.8', '3.0']));
  }, 120_000);

  it('states the print scales, or that the units are unknown, and names the grade base in the right unit', async () => {
    const metric = (await drawn(base({ style: 'light' }))).texts;
    expect(metric.some((t) => /^Horizontal 1:[\d,]+  ·  Vertical 1:[\d,]+  ·  .*print at 100% on A3$/.test(t))).toBe(true);
    vi.restoreAllMocks();
    const unverified = (await drawn(base({ style: 'light', unitSystem: 'unverified' }))).texts;
    expect(unverified.some((t) => t.startsWith('Horizontal and vertical scale: units unknown'))).toBe(true);
    expect(unverified.some((t) => t.includes('units of chainage (unit unverified)'))).toBe(true);
    expect(unverified).toContain('STEEPEST OVER 10 UNITS (%)');
    expect(unverified.some((t) => / m of chainage/.test(t))).toBe(false);
  });

  it('finishes on a corrupt sample with a non-finite chainage instead of looping', async () => {
    const bad = samples(false);
    bad[bad.length - 1] = { ...bad[bad.length - 1]!, distance: Number.POSITIVE_INFINITY };
    const bytes = await buildProfilePdf(base({ style: 'dark', samples: bad }));
    expect(bytes.length).toBeGreaterThan(1000);
  }, 30_000);

  it('says why the plan strip is missing: no terrain run, or extras that could not be read', async () => {
    const noTerrain = (await drawn(base({ style: 'light', extras: { returns: null, plan: null } }))).texts;
    expect(noTerrain.some((t) => t.includes('no terrain run gives a surface'))).toBe(true);
    vi.restoreAllMocks();
    const unread = (await drawn(base({ style: 'light', extras: null }))).texts;
    expect(unread.some((t) => t.includes('could not be read for this export'))).toBe(true);
    expect(unread.some((t) => t.includes('no terrain run'))).toBe(false);
  });

  it('still draws when the font files cannot be loaded', async () => {
    const bytes = await buildProfilePdf(base({ style: 'light', loadFont: async () => { throw new Error('offline'); } }));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  }, 120_000);
});

describe('figures', () => {
  const st = (pairs: Array<[number, number | null]>) => pairs.map(([chainage, elevation]) => ({ chainage, elevation }));

  it('index crossings land where the ground line passes each level, never across a gap', () => {
    const c = indexCrossings(st([[0, 95], [10, 105], [20, 115], [30, null], [40, 125]]), [100, 110, 120]);
    expect(c.map((x) => [x.chainage, x.height])).toEqual([[5, 100], [15, 110]]);
  });

  it('grade over 10 m is null where a gap breaks the base', () => {
    const g = gradeSeries(st([[0, 0], [5, 1], [10, 2], [15, null], [20, 4], [25, 5], [30, 6]]), 30);
    expect(g[0]).toEqual({ chainage: 5, grade: 20 });
    expect(g.find((x) => x.chainage === 15)!.grade).toBeNull();
    expect(g.at(-1)).toEqual({ chainage: 25, grade: 20 });
  });

  it('returns per metre follow the sample counts and spacing', () => {
    expect(countsPerStation([{ distance: 0, height: 1, count: 10 }, { distance: 2, height: 1, count: 6 }, { distance: 3, height: 1 }])).toEqual([5, 6, null]);
  });

  it('the support sheets take the style colours', () => {
    const ink = profileInkFor(sheetTokens('dark'));
    const ink2 = sheetTokens('dark').ink;
    expect([ink.INK.red, ink.INK.green, ink.INK.blue]).toEqual([...ink2]);
  });

  it('the section image matches the style, and Classic keeps its own ink', () => {
    expect(profileImageThemeFor('classic')).toBe(DEFAULT_PROFILE_IMAGE_THEME);
    expect(profileImageThemeFor('dark').pageBackground).toBe('#0c1116');
  });
});

describe('notesForRoom', () => {
  const h = (ls: string[][]): number => ls.reduce((a, l) => a + l.length, 0) * 10;
  const notes = [['1. a'], ['2. b', 'b2'], ['3. c'], ['4. d']];
  it('keeps every note when they fit', () => {
    expect(notesForRoom(notes, 50, h)).toEqual(notes);
  });
  it('prints the notes that fit whole and says which continue', () => {
    const out = notesForRoom(notes, 40, h);
    expect(out).toEqual([['1. a'], ['2. b', 'b2'], ['Notes 3 to 4 continue on the next sheet.']]);
    expect(h(out)).toBeLessThanOrEqual(40);
    expect(notesForRoom([...notes.slice(0, 3), ['4. d', 'd2']], 50, h).at(-1)).toEqual(['Note 4 continues on the next sheet.']);
  });
});

describe('sampleFrame', () => {
  it('reads the horizontal factor and the datum off a raw and converted pair', () => {
    const raw = [{ distance: 0, height: 5 }, { distance: 10, height: 6 }];
    const shown = raw.map((s) => ({ distance: s.distance * 0.3048, height: (s.height + 1000) * 0.3048 }));
    const f = sampleFrame(raw, shown, 0.3048)!;
    expect(f.f).toBeCloseTo(0.3048, 12);
    expect(f.datum).toBeCloseTo(1000, 9);
    expect(sampleFrame(raw, shown, 0)).toBeNull();
    expect(sampleFrame([{ distance: 0, height: 1 }], [{ distance: 0, height: 1 }], 1)).toBeNull();
  });
});

describe('returnsAgree', () => {
  const line = [{ distance: 0, height: 100 }, { distance: 10, height: 110 }, { distance: 20, height: 105 }];
  it('accepts returns on and above the line, refuses a set off by a datum', () => {
    const c = Float32Array.from([1, 5, 9, 12, 18]);
    expect(returnsAgree(c, Float64Array.from([101, 106, 109.5, 112, 108]), line)).toBe(true);
    expect(returnsAgree(c, Float64Array.from([1901, 1906, 1909.5, 1912, 1908]), line)).toBe(false);
    expect(returnsAgree(c, Float64Array.from([1, 2, 3, 4, 5]), [{ distance: 0, height: Number.NaN }])).toBe(false);
  });
});
