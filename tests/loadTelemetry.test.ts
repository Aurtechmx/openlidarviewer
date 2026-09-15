import { formatTelemetry } from '../src/io/loadTelemetry';

describe('formatTelemetry', () => {
  test('renders only the stages that were actually timed', () => {
    const out = formatTelemetry({ decodeMs: 100, totalLoadMs: 250 });
    expect(out).toContain('decode');
    expect(out).toContain('total');
    expect(out).not.toContain('downsample');
    expect(out).not.toContain('file read');
  });

  test('formats each timing to one decimal with a ms unit', () => {
    expect(formatTelemetry({ decodeMs: 123.456 })).toContain('123.5 ms');
  });

  test('returns a placeholder when nothing was measured', () => {
    expect(formatTelemetry({})).toBe('(no telemetry)');
  });

  test('reports the preview arrival between transfer and parse when one was sent', () => {
    const out = formatTelemetry({ transferMs: 5, previewMs: 120, parseMs: 1 });
    expect(out.indexOf('transfer')).toBeLessThan(out.indexOf('preview'));
    expect(out.indexOf('preview')).toBeLessThan(out.indexOf('parse'));
    expect(formatTelemetry({ transferMs: 5, parseMs: 1 })).not.toContain('preview');
  });

  test('orders rows by pipeline stage, not by insertion order', () => {
    const out = formatTelemetry({ totalLoadMs: 999, sniffMs: 1 });
    expect(out.indexOf('sniff')).toBeLessThan(out.indexOf('total'));
  });
});
