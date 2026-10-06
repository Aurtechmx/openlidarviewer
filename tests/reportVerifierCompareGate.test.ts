import { describe, it, expect } from 'vitest';
import { createCompareGate, createKeyCompareFlow, describeComparedKey } from '../src/ui/reportVerifier';

describe('compare gate: which key check may be shown', () => {
  it('shows the newest request even when an older one resolves last', () => {
    const gate = createCompareGate();
    const a = gate.begin();
    const b = gate.begin();
    // B resolves first and is shown; A resolves afterwards and must not replace it.
    expect(gate.current(b, true)).toBe(true);
    expect(gate.current(a, true)).toBe(false);
  });

  it('drops a result once the key text has changed', () => {
    const gate = createCompareGate();
    const a = gate.begin();
    gate.retire();
    expect(gate.current(a, true)).toBe(false);
  });

  it('drops a result after the dialog closed', () => {
    const gate = createCompareGate();
    const a = gate.begin();
    expect(gate.current(a, false)).toBe(false);
  });
});

describe('describeComparedKey', () => {
  it('keeps a short key id whole and shortens long text', () => {
    expect(describeComparedKey('  abc123  ')).toBe('abc123');
    const long = describeComparedKey('{"kty":"EC","crv":"P-256","x":"AAAA","y":"BBBBBBBB"}');
    expect(long.length).toBeLessThan(25);
    expect(long).toContain('…');
  });
});

describe('compare flow', () => {
  type Sig = { status: string; signatureValid: boolean; reason: string };
  const sig = (status: string): Sig => ({ status, signatureValid: true, reason: status });

  function harness() {
    const pending = new Map<string, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
    const log = { verdict: 'baseline', note: '', busy: false };
    const flow = createKeyCompareFlow(
      (key) => new Promise((resolve, reject) => { pending.set(key, { resolve, reject }); }) as never,
      () => true,
      {
        showBaseline: () => { log.verdict = 'baseline'; },
        showVerdict: (v) => { log.verdict = v.status; },
        setNote: (t) => { log.note = t; },
        setBusy: (b) => { log.busy = b; },
      },
    );
    return { flow, pending, log };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('keeps the newer key verdict when an older compare resolves last', async () => {
    const { flow, pending, log } = harness();
    const a = flow.run('key-a');
    const b = flow.run('key-b');
    pending.get('key-b')!.resolve({ signature: sig('valid-different-key') });
    await b;
    pending.get('key-a')!.resolve({ signature: sig('valid-trusted-key') });
    await a;
    expect(log.verdict).toBe('valid-different-key');
    expect(log.note).toBe('Checked against: key-b');
  });

  it('drops the shown verdict and any check in flight when a key file replaces the text', async () => {
    const { flow, pending, log } = harness();
    const a = flow.run('key-a');
    pending.get('key-a')!.resolve({ signature: sig('valid-trusted-key') });
    await a;
    expect(log.verdict).toBe('valid-trusted-key');

    // A key loaded from a file (or cleared by the size check) sets the text from
    // code, which fires no input event; the file handler calls keyChanged.
    const again = flow.run('key-a');
    flow.keyChanged();
    expect(log.verdict).toBe('baseline');
    expect(log.busy).toBe(false);
    pending.get('key-a')!.resolve({ signature: sig('valid-trusted-key') });
    await again;
    await tick();
    expect(log.verdict).toBe('baseline');
  });

  it('re-enables Compare and says so when the current check returns no signature', async () => {
    const { flow, pending, log } = harness();
    const a = flow.run('key-a');
    expect(log.busy).toBe(true);
    pending.get('key-a')!.resolve({});
    await a;
    expect(log.busy).toBe(false);
    expect(log.note).toBe('The check could not be completed.');
  });

  it('re-enables Compare when the check throws', async () => {
    const { flow, pending, log } = harness();
    const a = flow.run('key-a');
    pending.get('key-a')!.reject(new Error('x'));
    await a;
    expect(log.busy).toBe(false);
    expect(log.note).toMatch(/could not be completed/);
  });
});
