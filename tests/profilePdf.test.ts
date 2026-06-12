/**
 * profilePdf.test.ts — the PDF export must actually produce bytes for
 * real profiles, including names with characters outside WinAnsi (the
 * pdf-lib StandardFont encoding) which would otherwise throw.
 */

import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { buildProfilePdf } from '../src/render/measure/profilePdf';
import type { ProfileChartSample } from '../src/render/measure/types';

function ramp(n: number): ProfileChartSample[] {
  const out: ProfileChartSample[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ distance: i * 2, height: 100 + Math.sin(i / 4) * 3 });
  }
  return out;
}

const PDF_MAGIC = '%PDF-';

describe('buildProfilePdf', () => {
  it('produces a non-empty PDF for a normal profile', async () => {
    const bytes = await buildProfilePdf({ name: 'Profile 1', samples: ramp(64) });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('does not throw on names with non-WinAnsi characters', async () => {
    // Emoji + Greek + CJK in a renamed measurement must not crash the
    // StandardFont encoder.
    const bytes = await buildProfilePdf({ name: 'Survey Δ 测量 🚧 §1', samples: ramp(8) });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('handles a profile with gaps (NaN heights) without throwing', async () => {
    const s = ramp(10);
    s[3] = { distance: 6, height: NaN };
    s[4] = { distance: 8, height: NaN };
    const bytes = await buildProfilePdf({ name: 'Gappy', samples: s, residentOnly: true });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });

  it('handles an all-gap profile (nothing to plot)', async () => {
    const bytes = await buildProfilePdf({
      name: 'Empty',
      samples: [
        { distance: 0, height: NaN },
        { distance: 10, height: NaN },
      ],
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe(PDF_MAGIC);
  });
});

/**
 * Recover the drawn text from the PDF bytes. pdf-lib Flate-compresses page
 * content streams and encodes every string drawn with a standard font as a
 * hex string (`<48656C6C6F> Tj`), so a plain byte-grep can never see the
 * words — inflate each stream, then hex-decode the string tokens back to
 * WinAnsi/latin1. Good enough to assert "this label made it onto the page";
 * NOT a layout check.
 */
function drawnPdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  let idx = 0;
  let streams = '';
  for (;;) {
    const s = buf.indexOf('stream', idx);
    if (s === -1) break;
    let ds = s + 'stream'.length;
    if (buf[ds] === 0x0d) ds++;
    if (buf[ds] === 0x0a) ds++;
    const e = buf.indexOf('endstream', ds);
    if (e === -1) break;
    try {
      streams += inflateSync(buf.subarray(ds, e)).toString('latin1');
    } catch {
      streams += buf.subarray(ds, e).toString('latin1'); // uncompressed stream
    }
    idx = e + 'endstream'.length;
  }
  return streams.replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
    Buffer.from(hex, 'hex').toString('latin1'),
  );
}

describe('provenance metadata (v0.4.5, B4)', () => {
  it('prints CRS / corridor / percentile when supplied instead of the defaults', async () => {
    const bytes = await buildProfilePdf({
      name: 'Levee section A',
      samples: ramp(16),
      corridorWidthM: 12.5,
      groundPercentile: 25,
      crs: 'EPSG:2225 - NAD83 / California zone 1 (ftUS)',
      verticalDatum: 'NAVD88',
    });
    const text = drawnPdfText(bytes);
    expect(text).toContain('EPSG:2225'); // header line + summary row
    expect(text).toContain('NAVD88');
    expect(text).toContain('12.50 m'); // the real corridor, not "auto"
    expect(text).toContain('ground p25'); // header provenance line
    expect(text).not.toContain('auto (5% of length)');
    expect(text).not.toContain('not georeferenced');
  });

  it('keeps the honest fallbacks when nothing is known', async () => {
    const bytes = await buildProfilePdf({ name: 'Local scan', samples: ramp(8) });
    const text = drawnPdfText(bytes);
    expect(text).toContain('auto (5% of length)');
    expect(text).toContain('not georeferenced');
  });
});

describe('unit system (v0.4.5, B9) — the sheet honours the active toggle end-to-end', () => {
  it('imperial: axes, summary and station table all print feet / 100-ft stations', async () => {
    const bytes = await buildProfilePdf({
      name: 'Imperial section',
      samples: ramp(16),
      corridorWidthM: 12.5,
      unitSystem: 'imperial',
    });
    const text = drawnPdfText(bytes);
    // Chart axes.
    expect(text).toContain('Elevation (ft)');
    expect(text).toContain('Chainage (100 ft stations)');
    // Chainage gridline labels use US 100-ft stationing: the ramp spans
    // 30 m = 98.43 ft → nice interval 10 ft → second gridline at "0+10.00".
    expect(text).toContain('0+10.00');
    // Summary: length 30 m = 98.4252 ft → "98.43 ft" via formatLength; the
    // corridor 12.5 m = 41.0105 ft → "41.01 ft".
    expect(text).toContain('98.43 ft');
    expect(text).toContain('41.01 ft');
    // Station table: header names the unit; elevations convert per station
    // (station 0 sits at exactly 100 m = 328.0840 ft → "328.08").
    expect(text).toContain('elevation (ft)');
    expect(text).toContain('328.08');
  });

  it('metric stays the default sheet when no unit system is passed', async () => {
    const bytes = await buildProfilePdf({ name: 'Metric section', samples: ramp(16) });
    const text = drawnPdfText(bytes);
    expect(text).toContain('Elevation (m)');
    expect(text).toContain('Chainage (station km+m)');
    expect(text).toContain('elevation (m)');
    expect(text).not.toContain('Elevation (ft)');
  });
});
