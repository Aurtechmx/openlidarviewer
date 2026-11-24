/**
 * mapSheetEnglish.test.ts: the English map sheet, in every state and style,
 * draws what it drew before the sheet could be written in other languages.
 * The digest is of the drawn text and lines, with numbers rounded so it does
 * not depend on the last digits a processor computes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFPage } from 'pdf-lib';
import { buildContourSheetPdf } from '../src/render/measure/mapSheetStyled';
import { MAP_STATES, mapInput } from './helpers/mapSheetStates';
import digests from './fixtures/mapSheetEnglish.json';

const loadFont = async (n: string): Promise<Uint8Array> => new Uint8Array(await readFile(join(process.cwd(), 'src', 'export', 'sheetKit', 'fonts', n)));
afterEach(() => { vi.restoreAllMocks(); });

async function drawDigest(name: string, style?: 'classic'): Promise<string> {
  const h = createHash('sha256');
  let calls = 0;
  for (const method of ['drawText', 'drawLine', 'drawRectangle', 'drawSvgPath', 'drawCircle'] as const) {
    const orig = PDFPage.prototype[method] as (...a: unknown[]) => unknown;
    vi.spyOn(PDFPage.prototype, method).mockImplementation(function (this: PDFPage, ...a: unknown[]) {
      calls++;
      h.update(method + JSON.stringify(a, (k, v) => (k === 'font' ? v?.name : typeof v === 'number' ? Number(v.toFixed(3)) : v)).replace(/-?\d+\.\d{4,}/g, (n) => String(Number(Number(n).toFixed(3)))).replace(/-0(?![.\d])/g, '0'));
      return orig.apply(this, a);
    } as never);
  }
  await buildContourSheetPdf(mapInput(style ? { ...MAP_STATES[name], style } : MAP_STATES[name]), { loadFont });
  vi.restoreAllMocks();
  expect(calls).toBeGreaterThan(20);
  return h.digest('hex');
}
describe('the English map sheet', () => {
  const recorded = digests as Record<string, { styled: string; classic: string }>;
  it('has a digest for every state', () => { expect(Object.keys(recorded).sort()).toEqual(Object.keys(MAP_STATES).sort()); });
  for (const name of Object.keys(MAP_STATES)) {
    it(name, async () => {
      expect({ styled: await drawDigest(name), classic: await drawDigest(name, 'classic') }).toEqual(recorded[name]);
    }, 240_000);
  }
});

if (process.env.RECORD_MAP_SHEET) {
  it('record', async () => {
    const out: Record<string, object> = {};
    for (const name of Object.keys(MAP_STATES)) out[name] = { styled: await drawDigest(name), classic: await drawDigest(name, 'classic') };
    (await import('node:fs')).writeFileSync(join(process.cwd(), 'tests/fixtures/mapSheetEnglish.json'), `${JSON.stringify(out, null, 1)}\n`);
  }, 600_000);
}
