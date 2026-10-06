/**
 * Text taken from a file (names, CRS labels) must not start a new line in a
 * text header or a ZIP entry, and the export surfaces say what is written.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { runBatch, dedupeName, type BatchInput } from '../src/convert/convertRunner';
import { buildZip } from '../src/convert/zipStore';
import { writeXyz, writeAsc } from '../src/convert/writeAscii';
import { sourceFileLine, measurementCsvProvenance } from '../src/export/exportProvenanceLines';
import { MAX_ENTRY_NAME_BYTES, safeEntryName, singleLine, unsafeEntryName } from '../src/export/safeText';
import { exportDigests } from '../src/science/exportDigestRecord';
import { buildExportSummary } from '../src/export/exportSummary';
import { fitProvenance, provenanceTrimmedMessage, type ConversionEvent } from '../src/convert/conversionEvents';
import { loadLas } from '../src/io/loadLas';
import { buildLas } from './helpers/rawLas';
import { parseSignedAt } from '../src/export/reportSignature';
import { readLas } from './helpers/rawLas';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Every line of an ASCII export is a comment or a numeric point row. */
function expectOnlyCommentsAndPoints(out: string, points: number): void {
  const lines = out.split('\n').filter((l) => l !== '');
  const rows = lines.filter((l) => !l.startsWith('#'));
  expect(rows).toHaveLength(points);
  for (const r of rows) expect(r).toMatch(/^-?\d/);
}

function cloud(name = 'scan.las', extra: Partial<ConstructorParameters<typeof PointCloud>[0]> = {}): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
    origin: [500000, 4100000, 0],
    sourceFormat: 'las',
    name,
    ...extra,
  });
}

describe('control characters in file-derived text', () => {
  it('singleLine replaces CR, LF, NEL and the Unicode separators', () => {
    expect(singleLine('a\r\nb\u2028c\u2029d\u0085e\u0000f')).toBe('a  b c d e f');
  });

  it('keeps a newline in the source file name out of the provenance line', () => {
    expect(sourceFileLine('dir/a.las\n# x')).toBe('Source file: a.las # x');
    expect(sourceFileLine('a\r1 2 3')).not.toMatch(/[\r\n]/);
  });

  it('keeps a newline in a CRS name or provenance line from creating a row, in both writers', () => {
    const g = { count: 2, x: Float64Array.from([1, 2]), y: Float64Array.from([3, 4]), z: Float64Array.from([5, 6]) };
    const xyz = writeXyz(g, 3, false, 'APPROXIMATE\n9 9 9', ['Source file: a\n7 7 7'], { epsg: null, crsName: 'UTM\n8 8 8' });
    expectOnlyCommentsAndPoints(xyz, 2);
    const asc = writeAsc(g, { crsName: 'UTM\r\n8 8 8', datumNote: 'n\n1 1 1', provenance: ['p\n2 2 2'] });
    expectOnlyCommentsAndPoints(asc, 2);
  });

  it('keeps a file named "a\\n# x" from adding a line to XYZ and ASC output, end to end', () => {
    for (const format of ['xyz', 'asc'] as const) {
      const c = cloud('evil.las\n# x\n1 2 3', {
        metadata: { crs: { source: 'wkt', name: 'Bad\n4 4 4', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } } as never,
      });
      const { file } = convertCloud(c, { format });
      const out = text(file!.bytes);
      expectOnlyCommentsAndPoints(out, 2);
      expect(file!.filename).not.toMatch(/[\r\n]/);
    }
  });

  it('keeps the measurement CSV provenance sidecar to one fact per line', () => {
    const out = measurementCsvProvenance(
      { version: '1', commit: 'c', dirty: false, source: 'a', sha256: null, crs: 'x', generatedAt: 't' } as never,
      { pointBasis: 'Point basis: full file', classesEdited: false, sourceName: 'a.las\nCRS: forged' },
    );
    expect(out.split('\n').filter((l) => l.startsWith('CRS:'))).toHaveLength(1);
  });
});

describe('ZIP entry names', () => {
  const bytes = new Uint8Array(1);
  it.each(['a\nb.las', '../x.las', 'a/../b.las', '/abs.las', 'C:\\x.las', 'a\\b.las', '', 'a//b.las', './a.las'])('refuses %j', (name) => {
    expect(unsafeEntryName(name)).not.toBeNull();
    expect(() => buildZip([{ name, bytes }])).toThrow(/Cannot ZIP/);
  });

  it('accepts a plain name and a relative path', () => {
    expect(() => buildZip([{ name: 'a.las', bytes }, { name: 'dir/b.las', bytes }])).not.toThrow();
  });

  it('safeEntryName drops the directory, controls and dot-only names', () => {
    expect(safeEntryName('../../etc/passwd')).toBe('passwd');
    expect(safeEntryName('a\nb.las')).toBe('a_b.las');
    expect(safeEntryName('..')).toBe('file');
    // ":" is reserved on Windows, so a drive-like prefix becomes "_" and the
    // rest of the name is kept; nothing is cut from a name that was safe.
    expect(safeEntryName('C:evil.las')).toBe('C_evil.las');
    expect(safeEntryName('Site: A.las')).toBe('Site_ A.las');
    expect(safeEntryName('site-a.las')).toBe('site-a.las');
  });

  it('safeEntryName removes bidi controls and zero-width characters', () => {
    // A right-to-left override would show "evil\u202Esal.exe" as "evilexe.las".
    expect(safeEntryName('evil\u202Esal.exe')).toBe('evilsal.exe');
    for (const ch of ['\u202A', '\u202B', '\u202C', '\u202D', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F', '\u200B', '\u200C', '\u200D', '\uFEFF']) {
      expect(safeEntryName(`a${ch}b.las`)).toBe('ab.las');
      expect(singleLine(`a${ch}b`)).toBe('ab');
      expect(unsafeEntryName(`a${ch}b.las`)).not.toBeNull();
    }
  });

  it.each(['CON', 'con.las', 'PRN.txt', 'AUX', 'NUL.tar.gz', 'COM1', 'com9.las', 'LPT1', 'lpt9.xyz'])('safeEntryName prefixes the Windows device name %s', (name) => {
    expect(safeEntryName(name)).toBe(`_${name}`);
  });

  it('safeEntryName keeps names that only start like a device name', () => {
    expect(safeEntryName('console.las')).toBe('console.las');
    expect(safeEntryName('COM10.las')).toBe('COM10.las');
    expect(safeEntryName('nullable.las')).toBe('nullable.las');
  });

  it('safeEntryName replaces <>:"|?* and trims trailing dots and spaces', () => {
    expect(safeEntryName('a<b>c:d"e|f?g*h.las')).toBe('a_b_c_d_e_f_g_h.las');
    expect(safeEntryName('scan.las. . ')).toBe('scan.las');
    expect(safeEntryName('  scan  ')).toBe('scan');
    expect(safeEntryName('. .')).toBe('file');
  });

  it('safeEntryName caps a long name at MAX_ENTRY_NAME_BYTES of UTF-8, keeping the extension and whole characters', () => {
    const ascii = safeEntryName(`${'a'.repeat(400)}.las`);
    expect(new TextEncoder().encode(ascii).length).toBe(MAX_ENTRY_NAME_BYTES);
    expect(ascii.endsWith('.las')).toBe(true);
    const wide = safeEntryName(`${'\u00e9'.repeat(150)}\u{1F600}${'\u00e9'.repeat(50)}.laz`);
    expect(new TextEncoder().encode(wide).length).toBeLessThanOrEqual(MAX_ENTRY_NAME_BYTES);
    expect(wide.endsWith('.laz')).toBe(true);
    expect(wide).not.toMatch(/\uFFFD/);
    expect([...wide].every((c) => c.codePointAt(0)! < 0xd800 || c.codePointAt(0)! > 0xdfff)).toBe(true);
    expect(safeEntryName('short.las')).toBe('short.las');
  });

  it('names a converted file safely and de-duplicates ignoring case', () => {
    const { file } = convertCloud(cloud('..\\..\\a\nb.las'), { format: 'xyz' });
    expect(unsafeEntryName(file!.filename)).toBeNull();
    const seen = new Set<string>();
    expect(dedupeName('A.las', seen)).toBe('A.las');
    expect(dedupeName('a.las', seen)).toBe('a (2).las');
    expect(dedupeName('A.LAS', seen)).toBe('A (3).LAS');
    // The same name in NFC and NFD forms is one name.
    expect(dedupeName('caf\u00e9.las', seen)).toBe('caf\u00e9.las');
    expect(dedupeName('cafe\u0301.las', seen)).toBe('cafe\u0301 (2).las');
  });
});

describe('safeEntryName edge cases', () => {
  it('is idempotent when the cap leaves a dot or space at the end', () => {
    const name = `${'x'.repeat(199)}.${'y'.repeat(20)}`;
    const once = safeEntryName(name);
    expect(once.endsWith('.')).toBe(false);
    expect(safeEntryName(once)).toBe(once);
    expect(new TextEncoder().encode(once).length).toBeLessThanOrEqual(MAX_ENTRY_NAME_BYTES);
    const spaced = safeEntryName(`${'x'.repeat(199)} ${'y'.repeat(30)}`);
    expect(spaced.endsWith(' ')).toBe(false);
    expect(safeEntryName(spaced)).toBe(spaced);
  });

  it('is idempotent over a fuzz set of awkward names', () => {
    const parts = ['.', '..', ' ', 'a', 'CON', 'com\u00b9', '\u202e', '\u00ad', '/', '\\', ':', '\n', 'x'.repeat(150), '\u00e9'.repeat(90), '.las'];
    let seed = 7;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let i = 0; i < 2000; i++) {
      const n = 1 + (next() % 6);
      let name = '';
      for (let k = 0; k < n; k++) name += parts[next() % parts.length];
      const once = safeEntryName(name);
      expect(safeEntryName(once), JSON.stringify(name)).toBe(once);
      expect(unsafeEntryName(once), JSON.stringify(name)).toBeNull();
      expect(once.startsWith('.'), JSON.stringify(name)).toBe(false);
      expect(once.length).toBeGreaterThan(0);
    }
  });

  it('does not leave a hidden file', () => {
    expect(safeEntryName('.hidden')).toBe('_hidden');
    expect(safeEntryName('..las')).toBe('_las');
    expect(safeEntryName(' .bashrc')).toBe('_bashrc');
    expect(safeEntryName('.\u202e.las')).toBe('_las');
    expect(safeEntryName('.')).toBe('file');
    expect(safeEntryName('a.las')).toBe('a.las');
  });

  it('removes the soft hyphen, Arabic letter mark, word joiner and invisible operators', () => {
    for (const ch of ['\u00ad', '\u061c', '\u180e', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064']) {
      expect(safeEntryName(`a${ch}b.las`)).toBe('ab.las');
      expect(singleLine(`a${ch}b`)).toBe('ab');
      expect(unsafeEntryName(`a${ch}b`)).not.toBeNull();
    }
  });

  it.each(['COM\u00b9', 'com\u00b2.las', 'LPT\u00b3', 'lpt\u00b9.txt', 'CON .txt', 'NUL  .las', 'aux .x'])('prefixes the device name %j', (name) => {
    expect(safeEntryName(name).startsWith('_')).toBe(true);
  });
});

describe('the export summary says what is written per format', () => {
  const base = { pointCount: 10, crsMode: 'keep' as const, format: 'las14' as const, classification: 'source' as const, includeClassification: true };

  it('says classes are not written for XYZ and ASC', () => {
    expect(buildExportSummary({ ...base, format: 'xyz' }).classificationLabel).toBe('Classification not written (XYZ has no class column)');
    expect(buildExportSummary({ ...base, format: 'asc' }).classificationLabel).toBe('Classification not written (ASC has no class column)');
  });

  it('raises no derived or cleared class warning for a format that writes no class', () => {
    for (const classification of ['derived', 'cleared'] as const) {
      const s = buildExportSummary({ ...base, format: 'xyz', classification });
      expect(s.warnings.some((w) => /classification|classes/i.test(w.message))).toBe(false);
    }
  });

  it('keeps the LAS wording', () => {
    expect(buildExportSummary(base).classificationLabel).toBe('Classification included (source)');
    expect(buildExportSummary({ ...base, format: 'las' }).classificationLabel).toBe('Classification included (source)');
  });
});

describe('batch provenance names the CRS origin the output is tagged with', () => {
  const crs = { source: 'wkt', name: 'WGS 84 / UTM zone 12N', epsg: 32612, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as never;
  const input = (name: string): BatchInput => ({ name, sizeBytes: 1, bytes: async () => new ArrayBuffer(1) });
  const record = (bytes: Uint8Array): string => text(readLas(bytes).vlrs.find((v) => v.recordId === 3)!.data);

  it('records the declared CRS with the name and EPSG the single export records for it, and tags the file the same way', async () => {
    const withCrs = cloud('a.las', { metadata: { crs } });
    const [r] = await runBatch([input('a.las')], { format: 'las14' }, async () => withCrs);
    expect(r.report.ok).toBe(true);
    const batchLine = record(r.file!.bytes).split('\n').find((l) => l.startsWith('CRS source'))!;
    expect(batchLine).toMatch(/^CRS source file-wkt \(WGS 84 \/ UTM zone 12N, EPSG:32612\)/);
    // The single export records the resolved CRS; for an unchanged file CRS it
    // has the same name and code, with the resolver's own source token.
    const resolved = { source: 'las-vlr', name: 'WGS 84 / UTM zone 12N', epsg: 32612 };
    const single = convertCloud(withCrs, { format: 'las14', digests: exportDigests({ sha256: null, note: 'n' }, resolved) });
    const singleLine_ = record(single.file!.bytes).split('\n').find((l) => l.startsWith('CRS source'))!;
    const nameAndCode = (l: string): string => /\(([^)]*)\)/.exec(l)![1];
    expect(nameAndCode(batchLine)).toBe(nameAndCode(singleLine_));
    const wkt = (b: Uint8Array): string => text(readLas(b).vlrs.find((v) => v.recordId === 2112)!.data);
    expect(wkt(r.file!.bytes)).toBe(wkt(single.file!.bytes));
  });

  it('says unknown when the file declares none, and tags nothing', async () => {
    const [r] = await runBatch([input('b.las')], { format: 'las14' }, async () => cloud('b.las'));
    expect(record(r.file!.bytes)).toMatch(/CRS source unknown/);
  });
});

describe('ASCII output records the fields it does not hold', () => {
  const rich = (): PointCloud => cloud('r.las', {
    classification: Uint8Array.from([2, 6]),
    classificationFlags: Uint8Array.from([4, 0]),
    returnNumber: Uint8Array.from([1, 2]),
    returnCount: Uint8Array.from([2, 2]),
    gpsTime: Float64Array.from([1, 2]),
    intensity: Uint16Array.from([10, 20]),
    colors: Uint8Array.from([1, 2, 3, 4, 5, 6]),
  });

  it('XYZ lists class, flags, returns, GPS time and intensity in the report and the header', () => {
    const { file, report } = convertCloud(rich(), { format: 'xyz' });
    const ev = report.events!.find((e) => e.id === 'ascii-fields-dropped')!;
    expect(ev.kind).toBe('dropped');
    expect(ev.message).toMatch(/XYZ holds x, y, z and colour only/);
    for (const w of ['class', 'class flags', 'return number', 'GPS time', 'intensity']) expect(ev.message).toContain(w);
    expect(ev.message.split('Not written')[1]).not.toContain('colour');
    const out = text(file!.bytes);
    expect(out).toContain('# Conversion event ascii-fields-dropped: XYZ holds');
    expectOnlyCommentsAndPoints(out, 2);
  });

  it('ASC lists colour, and not intensity', () => {
    const { report } = convertCloud(rich(), { format: 'asc' });
    const ev = report.events!.find((e) => e.id === 'ascii-fields-dropped')!;
    const notWritten = ev.message.split('Not written')[1];
    expect(notWritten).toContain('colour');
    expect(notWritten).not.toContain('intensity');
  });

  it('is omitted when nothing is left out, and for omitted classes', () => {
    expect(convertCloud(cloud(), { format: 'xyz' }).report.events).toEqual([]);
    const only = cloud('c.las', { classification: Uint8Array.from([2, 6]) });
    const { report } = convertCloud(only, { format: 'xyz', omitClassification: true });
    expect(report.events).toEqual([]);
  });
});

describe('ASCII output from a LAS 1.4 scanner-channel file', () => {
  it('lists the scanner channel, user data and scan direction it leaves out', async () => {
    const src = buildLas({ version: '1.4', pdrf: 6, points: [{ cls: 2, channel: 2 }, { cls: 2, channel: 1 }] });
    const decoded = await loadLas(src.buffer.slice(0) as ArrayBuffer, 'las', 'ch.las', 1, undefined, true);
    expect(decoded.scannerChannel).toBeDefined();
    const { report } = convertCloud(decoded, { format: 'xyz' });
    const msg = report.events!.find((e) => e.id === 'ascii-fields-dropped')!.message;
    expect(msg).toContain('scanner channel');
    expect(msg).toContain('user data');
    expect(msg).toContain('scan direction and edge of flight line');
  });
});

describe('an export that keeps no points', () => {
  it('fails with a clear message instead of writing an empty file', async () => {
    const empty = cloud('e.las', { positions: new Float32Array(0) });
    const r = convertCloud(empty, { format: 'las14' });
    expect(r.file).toBeNull();
    expect(r.report.ok).toBe(false);
    expect(r.report.log.at(-1)!.message).toMatch(/no points/);
  });
});

describe('conversion events that overflow the text area', () => {
  const ev = (i: number): ConversionEvent => ({
    id: `class-meaning-${i}`, kind: 'reinterpreted', level: 'warn', points: 1, message: 'x'.repeat(400), acknowledged: false,
  });

  it('keeps what fits, counts the rest, and says so', () => {
    const events = Array.from({ length: 300 }, (_, i) => ev(i));
    const fit = fitProvenance(['Point basis: full file'], null, events);
    expect(fit.trimmed).toBe(true);
    expect(fit.eventsOmitted).toBeGreaterThan(0);
    expect(fit.lines.join('\n').length).toBeLessThan(0xffff);
    expect(fit.lines.at(-1)).toMatch(new RegExp(`^${fit.eventsOmitted} further conversion events could not be listed`));
    expect(fit.lines.filter((l) => l.startsWith('Conversion event ')).length + fit.eventsOmitted).toBe(300);
  });
});

describe('the text area limit counts UTF-8 bytes', () => {
  const one: ConversionEvent = { id: 'scan-angle-clipped', kind: 'clipped', level: 'warn', points: 1, message: 'm', acknowledged: true };

  it('trims a record whose characters fit but whose bytes do not', () => {
    // 40,000 two-byte characters: 40,000 UTF-16 units, 80,000 bytes.
    const fit = fitProvenance(['\u00e9'.repeat(40_000)], null, [one]);
    expect(fit.trimmed).toBe(true);
    expect(fit.lines).toEqual([expect.stringMatching(/^Conversion event scan-angle-clipped:/)]);
  });

  it('names both the provenance lines and the events when it drops both', () => {
    expect(provenanceTrimmedMessage(3)).toMatch(/the other provenance lines and 3 conversion events are not recorded/);
    expect(provenanceTrimmedMessage(1)).toMatch(/the other provenance lines and 1 conversion event are not recorded/);
    expect(provenanceTrimmedMessage(0)).toMatch(/only the conversion events are recorded/);
  });
});

describe('parseSignedAt years', () => {
  it.each([
    ['0050-01-01T00:00:00Z', '0050-01-01T00:00:00.000Z'],
    ['0099-12-31T23:59:59Z', '0099-12-31T23:59:59.000Z'],
    ['0100-01-01T00:00:00Z', '0100-01-01T00:00:00.000Z'],
    ['0004-02-29T00:00:00Z', '0004-02-29T00:00:00.000Z'],
    ['1970-01-01T00:00:00Z', '1970-01-01T00:00:00.000Z'],
    ['1999-06-15T12:00:00.5Z', '1999-06-15T12:00:00.500Z'],
  ])('%s', (input, iso) => {
    expect(parseSignedAt(input)).toBe(iso);
  });

  it('still refuses an impossible date in a low year', () => {
    expect(parseSignedAt('0100-02-29T00:00:00Z')).toBeNull();
  });
});

describe('the browser download name', () => {
  it('is one plain file name, whatever the scan or layer was called', async () => {
    const anchors: { download: string }[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { document: g.document, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
    g.document = {
      createElement: () => { const a = { href: '', download: '', click() {}, remove() {} }; anchors.push(a); return a; },
      body: { appendChild() {} },
    };
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => {};
    try {
      const { triggerDownload } = await import('../src/io/download');
      triggerDownload(new Blob(['x']), 'site/a\\b..\nx-terrain-access.zip');
      triggerDownload(new Blob(['x']), 'plain.las');
    } finally {
      g.document = saved.document;
      URL.createObjectURL = saved.createObjectURL;
      URL.revokeObjectURL = saved.revokeObjectURL;
    }
    expect(anchors.map((a) => a.download)).toEqual(['b.._x-terrain-access.zip', 'plain.las']);
  });
});
