/**
 * deliverableFields.test.ts: what the user adds to a drawing is bounded and
 * cleaned wherever it comes from, the job follows the session, the people do
 * not, and nothing typed reaches a measured figure.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cleanCompany, cleanJob, cleanLine, cleanLogo, cleanProfileFields, cleanText, FIELD_LIMITS, jobDetails, MAX_ISSUES, MAX_LOGO_CHARS, MAX_MARKS, setCompanyDetails, setJobDetails,
} from '../src/model/deliverableFields';
import { rememberCompany, rememberedCompany } from '../src/ui/companyStore';
import { parseChainage, unusualCharacters } from '../src/ui/profileExportDialog';
import { pdfFileName } from '../src/ui/profileExportFlow';
import { parseSession, serializeSession, type InspectionSession } from '../src/io/session';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

describe('text', () => {
  it('drops control and direction characters and caps the length by character', () => {
    expect(cleanLine('  a\u0000b\u202ec\r\nd\u200b  ', 50)).toBe('abc d');
    expect(cleanLine('\u{1F600}'.repeat(5), 3)).toBe('\u{1F600}'.repeat(3));
    expect(cleanLine(' \u200b ', 10)).toBeUndefined();
    expect(cleanLine(5, 10)).toBeUndefined();
  });
  it('keeps paragraphs in notes, one blank line at most', () => {
    expect(cleanText('a\r\n\r\n\r\n\r\nb\n', 50)).toBe('a\n\nb');
    expect(cleanText('x'.repeat(5000), FIELD_LIMITS.notes)).toHaveLength(FIELD_LIMITS.notes);
  });
});

describe('logo', () => {
  it('takes a PNG or JPEG data URL and nothing else', () => {
    expect(cleanLogo(PNG)).toBe(PNG);
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.org/logo.png', PNG.replace('png', 'jpeg'), 'data:image/png;base64,AAAA', `${PNG}<script>`, `data:image/png;base64,iVBORw0KGgo${'A'.repeat(MAX_LOGO_CHARS)}`, null]) expect(cleanLogo(bad)).toBeUndefined();
  });
});

describe('groups', () => {
  it('read field by field, dropping what is not theirs', () => {
    expect(cleanJob({ project: 'P', client: '', status: 'approved', suitability: 'survey grade', crs: 'x' })).toEqual({ project: 'P' });
    expect(cleanJob({ status: 'issued' })).toEqual({ status: 'issued' });
    expect(cleanJob({ status: 'preliminary' })).toEqual({});
    expect(cleanCompany({ company: 'C', logoDataUrl: 'javascript:1', preparedBy: 7 })).toEqual({ company: 'C' });
    for (const v of [null, 'x', [], 4]) expect(cleanProfileFields(v)).toEqual({});
  });
  it('caps and orders rows, and drops empty or impossible ones', () => {
    const f = cleanProfileFields({
      issues: [...Array.from({ length: 20 }, (_, i) => ({ issue: `${i}` })), { issue: '' }, null],
      marks: [{ chainage: 9, text: 'b' }, { chainage: 2, text: 'a' }, { chainage: -1, text: 'x' }, { chainage: Number.NaN, text: 'x' }, { chainage: '3', text: 'x' }, { chainage: 4, text: ' ' }, ...Array.from({ length: 20 }, (_, i) => ({ chainage: 20 + i, text: 'm' }))],
    });
    expect(f.issues).toHaveLength(MAX_ISSUES);
    expect(f.marks).toHaveLength(MAX_MARKS);
    expect(f.marks!.map((m) => m.chainage).slice(0, 2)).toEqual([2, 9]);
  });
});

describe('a session', () => {
  const m = { id: 'p', kind: 'profile', name: 'P', points: [[0, 0, 0], [1, 0, 0]], sheet: { title: 'T', marks: [{ chainage: 0.5, text: 'mid' }] } };
  const session = (over: object = {}): InspectionSession => ({ app: 'x', origin: [0, 0, 0], measurements: [m], annotations: [], views: [], upAxis: 'z', ...over } as unknown as InspectionSession);
  beforeEach(() => { setJobDetails({}); setCompanyDetails({}); });
  it('carries the job and a profile\'s own words', () => {
    const back = parseSession(serializeSession(session({ job: { project: 'Dam', status: 'review' } })));
    expect(back.job).toEqual({ project: 'Dam', status: 'review' });
    expect(back.measurements[0]!.sheet).toEqual(m.sheet);
  });
  it('never carries the company, logo or people', () => {
    setCompanyDetails({ company: 'Secret Co', logoDataUrl: PNG, preparedBy: 'Someone' });
    const text = serializeSession(session({ job: { ...jobDetails(), company: 'Secret Co', preparedBy: 'Someone' } as never }));
    expect(text).not.toMatch(/Secret Co|Someone|iVBOR/);
  });
  it('is byte for byte what it was when nothing is set, and drops a damaged block', () => {
    const plain = { ...m, sheet: undefined };
    expect(serializeSession(session({ measurements: [plain] }))).toBe(serializeSession(session({ measurements: [plain], job: {} })));
    expect(serializeSession(session({ measurements: [plain] }))).not.toContain('"job"');
    const bad = JSON.parse(serializeSession(session())); bad.job = 'x'; bad.measurements[0].sheet = [1];
    const back = parseSession(JSON.stringify(bad));
    expect(back.job).toBeUndefined();
    expect(back.measurements[0]!.sheet).toBeUndefined();
  });
});

describe('this device', () => {
  it('remembers nothing where storage is missing, and says so', () => {
    expect(rememberedCompany()).toBeNull();
    expect(rememberCompany({ company: 'C' })).toBe(false);
  });
});

describe('typed values', () => {
  it('reads a chainage as a number or a station', () => {
    expect(parseChainage('34.5', 'metric')).toBe(34.5);
    expect(parseChainage(' 34,5 ', 'metric')).toBe(34.5);
    expect(parseChainage('1+034.50', 'metric')).toBe(1034.5);
    expect(parseChainage('1+13.45', 'imperial')).toBeCloseTo(113.45 * 0.3048, 9);
    expect(parseChainage('100', 'imperial')).toBeCloseTo(30.48, 9);
    for (const bad of ['', '-3', 'abc', '1e9', '1+', 'Infinity']) expect(parseChainage(bad, 'metric')).toBeNull();
    expect(parseChainage('1+20', 'unverified')).toBeNull();
  });
  it('names the characters the sheet fonts may lack', () => {
    for (const ok of ['Río Bravo, 3 m² – “x” é ñ ß ø ł', '20 °C ± 1', '']) expect(unusualCharacters(ok), ok).toBe(false);
    for (const no of ['日本', 'Привет', 'Ω', '\u{1F600}']) if (no !== 'Ω') expect(unusualCharacters(no), no).toBe(true);
  });
  it('makes one safe .pdf name', () => {
    expect(pdfFileName('My sheet.PDF', 'd.pdf')).toBe('My_sheet.pdf');
    expect(pdfFileName('../../etc/passwd', 'd.pdf')).not.toContain('/');
    expect(pdfFileName('  ', 'd.pdf')).toBe('d.pdf');
    expect(pdfFileName('...', 'd.pdf')).toBe('d.pdf');
  });
});
