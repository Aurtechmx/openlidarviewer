/**
 * profileSheetStyled.test.ts: the Light and Dark profile sheet, the figures
 * it draws, and the inputs the app builds for it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFPage } from 'pdf-lib';
import { buildProfilePdf, type ProfilePdfInput } from '../src/render/measure/profilePdf';
import { countsPerStation, fitColumns, gradeSeries } from '../src/render/measure/profileSheetStyled';
import { DEFAULT_PROFILE_IMAGE_THEME, profileImageThemeFor } from '../src/render/measure/profileSectionImage';
import { contourCrossings, profileSheetExtras, RETURNS_NOT_READ, RETURNS_UNRECORDED, returnsAgree, sampleFrame } from '../src/app/profileSheetExtras';
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
    it(`${style}: deterministic, and every station and note row printed`, async () => {
      const input = base({ style, extras: { returns: returns(), plan: plan(), indexCrossings: [{ chainage: 30, height: 110 }, { chainage: 95, height: 130 }] } });
      const { texts, bytes: a } = await drawn(input);
      vi.restoreAllMocks();
      const b = await buildProfilePdf(input);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      // The larger type can take more sheets than Classic; it never drops a row.
      const { texts: classicTexts, bytes: c } = await drawn(base());
      const stationsIn = (ts: string[]): number => ts.filter((t) => /^0\+\d{3}\.\d{2}$/.test(t)).length;
      expect(stationsIn(texts)).toBeGreaterThanOrEqual(stationsIn(classicTexts));
      for (const row of ['Length (horizontal)', 'Class exclusion', 'Read scope']) expect(texts).toContain(row);
      expect((await PDFDocument.load(a)).getPageCount()).toBeGreaterThanOrEqual((await PDFDocument.load(c)).getPageCount());
    }, 120_000);
  }
});

describe('the styled sheet one', () => {
  it('prints the headline figures, the scale statement and every general note', async () => {
    const { texts } = await drawn(base({ style: 'light', extras: { returns: returns(), plan: plan(), indexCrossings: [{ chainage: 30, height: 110 }, { chainage: 95, height: 130 }] } }));
    const all = texts.join('\n');
    for (const want of ['Profile A - B', 'Preliminary', 'm relief', 'long, measured along the line', 'End to end ', 'Steepest over 10 m: ', 'Highest ', 'Lowest ', 'Vertical ', 'Chainage', 'Grade %', 'True shape']) {
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
    const withAll = (await drawn(base({ style: 'dark', extras: { returns: returns(), plan: plan(), indexCrossings: [{ chainage: 30, height: 110 }] } }))).texts;
    expect(withAll).toEqual(expect.arrayContaining(['Ground returns', 'Other returns', 'Crosses an index contour', 'Grid N']));
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
    expect(unverified.some((t) => t.startsWith('Steepest over 10 units: '))).toBe(true);
    expect(unverified).toContain('units relief');
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

  it('sets the notes, method and schedule sheets in larger type than Classic, and Classic after it unchanged', async () => {
    const sizeOf = async (input: ProfilePdfInput, text: string): Promise<number> => {
      let size = 0;
      const orig = PDFPage.prototype.drawText;
      vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { size?: number }) {
        if (t === text && size === 0) size = o?.size ?? 0;
        return orig.call(this, t, o as never);
      });
      await buildProfilePdf(input);
      vi.restoreAllMocks();
      return size;
    };
    const classic = await sizeOf(base({ style: 'classic' }), 'Length (horizontal)');
    const styled = await sizeOf(base({ style: 'dark' }), 'Length (horizontal)');
    expect(classic).toBeGreaterThan(0);
    expect(styled).toBeGreaterThan(classic);
    // A Classic build after a styled one is byte for byte the first.
    const before = await buildProfilePdf(base({ loadFont: undefined }));
    await buildProfilePdf(base({ style: 'light' }));
    expect(Buffer.from(await buildProfilePdf(base({ loadFont: undefined }))).equals(Buffer.from(before))).toBe(true);
  });

  it('keeps the styled method sheet\'s source table cells inside the right margin', async () => {
    const provenance = {
      recordVersion: 1, method: 'corridor-percentile', corridorVersion: 1, capturedAt: '2026-01-01T00:00:00.000Z',
      up: [0, 0, 1], upDegenerate: false, acceptedCount: 10, scope: 'resident', residentOnly: true, complete: true,
      sources: [{ layerId: 'layer-1', displayName: 'Scan', classification: 'producer', streaming: true, acceptedCount: 10, contributed: true, residency: true }],
      classPolicy: { excludedClasses: [], availableOnEverySource: false },
      units: { linearUnit: 'metre', verticalReference: 'orthometric', verticalMetresPerUnit: 1 },
    };
    let right = 0;
    const orig = PDFPage.prototype.drawText;
    vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, text: string, o?: { x?: number; size?: number; font?: { widthOfTextAtSize(t: string, s: number): number } }) {
      if (text === 'complete' && o?.font && o.size) right = Math.max(right, (o.x ?? 0) + o.font.widthOfTextAtSize(text, o.size));
      return orig.call(this, text, o as never);
    });
    await buildProfilePdf(base({ style: 'dark', provenance } as never));
    expect(right).toBeGreaterThan(0);
    // A3 landscape, 48 pt margins: the content ends at 1142.55 pt.
    expect(right).toBeLessThanOrEqual(1190.55 - 48);
  });

  it('still draws when the font files cannot be loaded', async () => {
    const bytes = await buildProfilePdf(base({ style: 'light', loadFont: async () => { throw new Error('offline'); } }));
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
  }, 120_000);
});

describe('figures', () => {
  const st = (pairs: Array<[number, number | null]>) => pairs.map(([chainage, elevation]) => ({ chainage, elevation }));

  it('a crossing is where the contour meets the line on the ground, not where the profile reaches its height', () => {
    const f = (coordinates: Array<[number, number]>, over: object = {}) => ({ value: 5, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false, coordinates, ...over }) as never;
    const at = (...fs: never[]) => contourCrossings([0, 0], [10, 0], fs).map((c) => [c.along, c.value]);
    expect(at(f([[100, 100], [120, 100]]))).toEqual([]);
    expect(at(f([[4, -1], [4, 1]]))).toEqual([[4, 5]]);
    expect(at(f([[4, -1], [4, 0], [4, 1]]))).toEqual([[4, 5]]);
    expect(at(f([[12, -1], [12, 1]]))).toEqual([]);
    expect(at(f([[4, -1], [4, 1]], { isIndex: false }))).toEqual([]);
    expect(at(f([[2, 0], [8, 0]]))).toEqual([]);
    // A ring is closed by its last side; the disjoint part at the same value adds nothing.
    expect(at(f([[2, -1], [6, -1], [6, 1], [2, 1]], { closed: true }))).toEqual([[2, 5], [6, 5]]);
    expect(at(f([[4, -1], [4, 1]]), f([[50, 50], [60, 50]]))).toEqual([[4, 5]]);
    expect(contourCrossings([1, 1], [1, 1], [f([[0, 0], [2, 2]])])).toEqual([]);
  });

  it('grade over 10 m is null where a gap breaks the base', () => {
    const g = gradeSeries(st([[0, 0], [5, 1], [10, 2], [15, null], [20, 4], [25, 5], [30, 6]]), 30);
    expect(g[0]).toEqual({ chainage: 5, grade: 20 });
    expect(g.find((x) => x.chainage === 15)!.grade).toBeNull();
    expect(g.at(-1)).toEqual({ chainage: 25, grade: 20 });
  });

  it('returns per metre follow the sample counts and spacing, and leave out the ends', () => {
    expect(countsPerStation([{ distance: 0, height: 1, count: 10 }, { distance: 2, height: 1, count: 6 }, { distance: 3, height: 1 }])).toEqual([null, 6, null]);
  });

  it('the section image matches the style, and Classic keeps its own ink', () => {
    expect(profileImageThemeFor('classic')).toBe(DEFAULT_PROFILE_IMAGE_THEME);
    expect(profileImageThemeFor('dark').pageBackground).toBe('#0c1116');
  });
});

describe('fitColumns', () => {
  const b = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`);
  it('sets every block whole, down the columns', () => {
    const r = fitColumns([b(2), b(2), b(1)], 3, 3);
    expect(r.left).toBe(0);
    expect(r.placed.map((q) => [q.col, q.row])).toEqual([[0, 0], [1, 0], [1, 2]]);
  });
  it('says where the rest are when they do not fit', () => {
    const r = fitColumns([b(2), b(3), b(2), b(3)], 3, 3);
    expect(r.left).toBe(1);
    expect(r.placed.at(-1)).toEqual({ col: 2, row: 2, lines: ['Every note is on the method sheet.'] });
    for (const q of r.placed) expect(q.row + q.lines.length).toBeLessThanOrEqual(3);
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

describe('the Classic sheet one', () => {
  it('keeps the series key clear of the station band caption', async () => {
    const drawnAt: Array<{ page: PDFPage; t: string; x: number; y: number; w: number }> = [];
    const orig = PDFPage.prototype.drawText;
    vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (this: PDFPage, t: string, o?: { x?: number; y?: number; size?: number; font?: { widthOfTextAtSize(t: string, s: number): number } }) {
      drawnAt.push({ page: this, t, x: o?.x ?? 0, y: o?.y ?? 0, w: o?.font?.widthOfTextAtSize(t, o.size ?? 0) ?? 0 });
      return orig.call(this, t, o as never);
    });
    await buildProfilePdf(base({ style: 'classic' }));
    vi.restoreAllMocks();
    const key = drawnAt.find((d) => d.t.endsWith('see general note 1'))!;
    const sameLine = drawnAt.filter((d) => d !== key && d.page === key.page && Math.abs(d.y - key.y) < 6);
    expect(drawnAt.some((d) => d.t.startsWith('Station data band'))).toBe(true);
    for (const d of sameLine) expect(d.x >= key.x + key.w || d.x + d.w <= key.x, d.t).toBe(true);
  });
});

describe('profile extras and the scans they are read from', () => {
  const line: ProfileChartSample[] = [0, 2, 4, 6, 8, 10].map((d) => ({ distance: d, height: d, count: 1 }));
  const src = (layerId: string, over: object = {}) => ({ layerId, displayName: `${layerId}.las`, classification: 'absent', streaming: false, acceptedCount: 3, contributed: true, residency: null, ...over });
  interface Ref { kind?: string; id: string; name?: string }
  async function run(o: { sources?: object[]; refs: Ref[]; owner?: string; picks?: string[]; open?: Array<[id: string, name: string]>; streamingSourceId?: string; heights?: number[] }) {
    // Slot 0 holds heights 2 and 8, slot 1 holds 9 and 15, and so on.
    const slots: number[] = [], heights: number[] = [], chainage: number[] = [];
    o.refs.forEach((_, s) => { [2, 8].forEach((c, k) => { slots.push(s); chainage.push(c); heights.push(o.heights?.[s * 2 + k] ?? (s === 0 ? c : c + 7)); }); });
    const m = { id: 'p', kind: 'profile', profileChart: line, points: [[0, 0, 0], [10, 0, 10]], ...(o.owner ? { owner: { layerId: o.owner, frame: 'project' } } : {}), ...(o.picks ? { pickLayers: o.picks } : {}), ...(o.sources ? { profileProvenance: { sources: o.sources } } : {}) };
    const open = o.open ?? [['A', 'A.las'], ['B', 'B.las']];
    const asked: unknown[] = [];
    const viewer = {
      clouds: () => open.map(([id]) => id), getCloud: (id: string) => ({ name: open.find((l) => l[0] === id)![1], id }), layerSourceId: (c: { id: string }) => c.id,
      measure: { getMeasurements: () => [m], unitFrameOf: () => ({ unitToMetres: 1 }) },
      profileSeam: { *sectionChunks() { return { points: { count: slots.length, chainage, height: heights, sourceSlot: slots, classification: null }, sources: o.refs.map((r, slot) => ({ kind: 'static', slot, ...r })), ...(o.streamingSourceId ? { streamingSourceId: o.streamingSourceId } : {}) }; } },
    };
    const terrain = { sceneUpAxis: 'z', result: { dtm: {}, model: { features: [{ isIndex: true, value: 5, coordinates: [[100, 100], [120, 100]] }] } } };
    const x = await profileSheetExtras(viewer as never, 'p', { profileChart: line, profileCorridorWidthM: 1 } as never, (q) => { asked.push(q); return terrain as never; });
    return { heights: x!.returns ? Array.from(x!.returns.heightM) : null, note: x!.returnsNote ?? null, asked, x: x! };
  }

  it('draws the recorded scan only, when another is shown over it', async () => {
    expect(await run({ sources: [src('A')], refs: [{ id: 'A' }, { id: 'B' }] })).toMatchObject({ heights: [2, 8], note: null });
  });
  it('draws nothing of another scan when the recorded one is hidden, and says why', async () => {
    expect(await run({ sources: [src('A')], refs: [{ id: 'B' }] })).toMatchObject({ heights: null, note: RETURNS_NOT_READ });
    expect(await run({ sources: [src('A'), src('B')], refs: [{ id: 'A' }] })).toMatchObject({ heights: null, note: RETURNS_NOT_READ });
  });
  it('a recorded scan that gave no return is not needed', async () => {
    expect(await run({ sources: [src('A'), src('B', { contributed: false, acceptedCount: 0 })], refs: [{ id: 'A' }] })).toMatchObject({ heights: [2, 8] });
  });
  it('two scans of one file name are told apart by identity', async () => {
    const refs = [{ id: 'id1', name: 'scan.las' }, { id: 'id2', name: 'scan.las' }];
    const open: Array<[string, string]> = [['id1', 'scan.las'], ['id2', 'scan.las']];
    expect(await run({ sources: [src('id1', { displayName: 'scan.las' })], refs, open })).toMatchObject({ heights: [2, 8] });
    // A record that only names the file cannot say which.
    expect(await run({ sources: [src('scan.las', { displayName: 'scan.las' })], refs, open })).toMatchObject({ heights: null, note: RETURNS_NOT_READ });
    expect(await run({ sources: [src('scan.las', { displayName: 'scan.las' })], refs: [refs[1]!], open })).toMatchObject({ heights: null });
  });
  it('a hidden scan is not replaced by another of the same name', async () => {
    const open: Array<[string, string]> = [['id1', 'scan.las'], ['id2', 'other.las']];
    expect(await run({ sources: [src('id1', { displayName: 'other.las' })], refs: [{ id: 'id2', name: 'other.las' }], open })).toMatchObject({ heights: null, note: RETURNS_NOT_READ });
  });
  it('an id from an earlier session, or a record by file name, matches the one open scan of that name', async () => {
    const o = { refs: [{ id: 'A', name: 'A.las' }] };
    expect(await run({ ...o, sources: [src('old-id', { displayName: 'A.las' })] })).toMatchObject({ heights: [2, 8] });
    expect(await run({ ...o, sources: [src('A.las', { displayName: 'A.las' })] })).toMatchObject({ heights: [2, 8] });
    expect(await run({ ...o, sources: [src('old-id', { displayName: 'A.las' })], owner: 'closed' })).toMatchObject({ heights: null, note: RETURNS_NOT_READ });
    expect(await run({ ...o, sources: [src('old-id', { displayName: 'A.las' }), src('old-2', { displayName: 'B.las' })] })).toMatchObject({ heights: null });
  });
  it('a profile with no record draws returns only while one scan is open', async () => {
    expect(await run({ refs: [{ id: 'A' }], open: [['A', 'A.las']] })).toMatchObject({ heights: [2, 8] });
    expect(await run({ refs: [{ id: 'A' }] })).toMatchObject({ heights: null, note: RETURNS_UNRECORDED });
  });
  it('a stream is matched by its own identity, and an older record only for work that names no scan', async () => {
    const st = (layerId: string) => src(layerId, { streaming: true });
    const refs = [{ kind: 'resident', id: '0-0-0-0' }];
    const o = { refs, open: [], streamingSourceId: 'streaming:one' };
    expect(await run({ ...o, sources: [st('streaming:one')] })).toMatchObject({ heights: [2, 8] });
    expect(await run({ ...o, sources: [st('streaming:two')] })).toMatchObject({ heights: null, note: RETURNS_NOT_READ });
    expect(await run({ ...o, sources: [st('streaming')] })).toMatchObject({ heights: [2, 8] });
    expect(await run({ ...o, sources: [st('streaming')], owner: 'retired-scan' })).toMatchObject({ heights: null });
  });
  it('asks for the terrain of the picked scan, and marks no contour the line does not meet', async () => {
    const r = await run({ sources: [src('A')], refs: [{ id: 'A' }], owner: 'A', picks: ['B'] });
    expect(r.asked).toMatchObject([{ pickLayers: ['B'] }]);
    expect(r.x.indexCrossings).toEqual([]);
  });
  it('the sheet prints why the returns are missing', async () => {
    const { texts } = await drawn(base({ style: 'light', extras: { returns: null, returnsNote: RETURNS_NOT_READ } }));
    expect(texts.join(' ')).toContain('Returns under the line: not drawn');
  }, 120_000);
});

describe('station band labels', () => {
  for (const [system, per] of [['metric', 'm'], ['unverified', 'unit']] as const) {
    it(`counts accepted returns per ${per} (${system})`, async () => {
      const { texts } = await drawn(base({ style: 'light', unitSystem: system }));
      expect(texts).toContain(`Returns per ${per}`);
      expect(texts).toContain(`accepted returns per ${per},`);
      expect(texts.some((t) => t.startsWith('tallest bar '))).toBe(true);
      expect(texts.some((t) => /ground returns per/i.test(t))).toBe(false);
      expect(texts).toContain('Across a gap with no accepted returns');
    }, 120_000);
  }
});
