/**
 * profilePdf.test.ts — the PDF export must actually produce bytes for
 * real profiles, including names with characters outside WinAnsi (the
 * pdf-lib StandardFont encoding) which would otherwise throw.
 */

import { describe, it, expect } from 'vitest';
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
