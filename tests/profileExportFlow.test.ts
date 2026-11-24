/**
 * profileExportFlow.test.ts: the sheet is of the profile as it is when Export
 * is pressed, a refusal reaches the user, and a closed dialog saves nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ opened: null as null | { input: Record<string, unknown>; run: (c: object, closed: () => boolean) => Promise<void> }, built: [] as Array<Record<string, unknown>> }));
vi.mock('../src/ui/profileExportDialog', () => ({
  openProfileExportDialog: async (input: Record<string, unknown>, run: (c: object, closed: () => boolean) => Promise<void>) => { h.opened = { input, run }; return true; },
}));
vi.mock('../src/lazyChunks', () => ({
  loadProfilePdf: async () => ({ buildProfilePdf: async (i: Record<string, unknown>) => { h.built.push(i); return new Uint8Array([1]); } }),
}));
import { exportProfileSheet, ProfileExportRefusal, type ProfileExportRequest, type ProfileExportSource } from '../src/ui/profileExportFlow';

const source = (over: Partial<ProfileExportSource> = {}): ProfileExportSource => ({
  summary: { id: 'p', name: 'Profile 1', profileChart: [{ distance: 0, height: 1 }, { distance: 50, height: 2 }] } as never,
  context: { crs: 'EPSG:1', verticalDatum: null, scanName: 'scan' } as never, unitSystem: 'metric', ...over,
});
const choice = { deliverable: {}, fields: { title: 'T' }, fileName: 'x', paper: 'a3', unitSystem: 'imperial' };
const saved: object[] = [], files: string[] = [];
const request = (capture: () => ProfileExportSource): ProfileExportRequest => ({
  capture, extras: async () => null, fields: undefined, saveFields: (f) => saved.push(f), download: (_b, n) => files.push(n),
});
beforeEach(() => { h.opened = null; h.built.length = 0; saved.length = 0; files.length = 0; });

describe('exportProfileSheet', () => {
  it('reads the profile and its frame again as Export is pressed', async () => {
    let now = source();
    await exportProfileSheet(request(() => now));
    now = source({ summary: { ...source().summary, name: 'Renamed' } as never, context: { crs: 'EPSG:2', verticalDatum: null, scanName: 'scan' } as never });
    await h.opened!.run(choice, () => false);
    expect(h.built[0]).toMatchObject({ name: 'Renamed', crs: 'EPSG:2', unitSystem: 'imperial' });
    expect(files).toEqual(['x.pdf']);
    expect(saved).toEqual([{ title: 'T' }]);
  });
  it('a unit that became unverified is not printed as feet', async () => {
    let now = source();
    await exportProfileSheet(request(() => now));
    now = source({ unitSystem: 'unverified' });
    await h.opened!.run(choice, () => false);
    expect(h.built[0]).toMatchObject({ unitSystem: 'unverified' });
  });
  it('a profile that is gone or refused makes no file', async () => {
    let gone = false;
    await exportProfileSheet(request(() => { if (gone) throw new ProfileExportRefusal('This profile is no longer open.'); return source(); }));
    gone = true;
    await expect(h.opened!.run(choice, () => false)).rejects.toThrow('This profile is no longer open.');
    expect(files).toEqual([]);
  });
  it('closing while the sheet is made saves nothing', async () => {
    await exportProfileSheet(request(() => source()));
    await h.opened!.run(choice, () => true);
    expect([files, saved]).toEqual([[], []]);
  });
});
