/**
 * reportEnglishFrozen.test.ts: the English terrain report and Contour Studio
 * PDF, byte for byte as they were before they could be written in other
 * languages. One digest per sheet style over every state.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildTerrainReportPdf } from '../src/render/measure/terrainReportPdf';
import { buildContourStudioPdf } from '../src/terrain/export/contourStudioPdf';
import { buildContourPdfModel } from '../src/terrain/contourStudio/contourDeliverablePdfModel';
import { REPORT_OPTS, REPORT_STATES, STUDIO_STATES } from './helpers/terrainReportStates';

// The build line names the app version; a fixed one keeps the digests across releases.
vi.mock('../src/build/buildIdentity', async (orig) => ({ ...(await orig<object>()), buildIdentityProvenance: () => '0.0.0 (fixed) · test · built 2026-01-01T00:00:00.000Z' }));

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
const FROZEN: Record<string, string> = {
  'terrain classic': 'a1ba23594169bf0acbe50ed6cd1361ca64a4c73593525cd32a0109a61db493c8',
  'terrain light': '5ba8ab441b66c29335dd8895755b9fe47020c33a8ddcf24f6f32feab4336e851',
  'terrain dark': '2eb5908d829ec76fcb15c4a28147991b215dc0bd87fd1450970eecb05f935e58',
  'studio classic': 'a2b5bdc089fa3a3251bd094e5e97c741df0f50fce4db539fb7481b4520d58c40',
  'studio light': 'b603319d2756a6a56bb512d8dbb93843cf724e0a8d358fc5cce30345dc264552',
  'studio dark': '37e168081502fd78c32514967eb365b29ee67931cc44140a225c0c99a436c59f',
};

describe.each(['classic', 'light', 'dark'] as const)('%s', (style) => {
  it('the English terrain report is unchanged', async () => {
    const h = createHash('sha256');
    for (const { r, o } of Object.values(REPORT_STATES)) h.update(await buildTerrainReportPdf(r, { ...REPORT_OPTS, ...o }, { style, loadFont }));
    expect(h.digest('hex')).toBe(FROZEN[`terrain ${style}`]);
  }, 240_000);
  it('the English Contour Studio PDF is unchanged', async () => {
    const h = createHash('sha256');
    for (const s of Object.values(STUDIO_STATES)) h.update(await buildContourStudioPdf(buildContourPdfModel(s), { style, loadFont }));
    expect(h.digest('hex')).toBe(FROZEN[`studio ${style}`]);
  }, 120_000);
});
