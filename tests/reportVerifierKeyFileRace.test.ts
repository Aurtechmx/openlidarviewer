/**
 * reportVerifierKeyFileRace.test.ts — the trusted-key field takes only the
 * latest still-relevant file read.
 *
 * Reads are released by hand, so the order they finish in is chosen by the
 * test: a slower earlier read finishing last, and a read finishing after the
 * user typed into the field.
 */
import { describe, it, expect } from 'vitest';
import { createKeyFileLoader, KEY_FILE_READ_FAILED, type KeyFileSource } from '../src/ui/keyFileLoader';
import { KEY_FILE_MAX_BYTES, keyFileProblem } from '../src/ui/reportVerifier';

interface Controlled extends KeyFileSource {
  resolve(text: string): void;
  reject(): void;
}

function controlledFile(size = 10): Controlled {
  let ok!: (t: string) => void;
  let fail!: (e: Error) => void;
  const p = new Promise<string>((res, rej) => { ok = res; fail = rej; });
  return { size, text: () => p, resolve: (t) => ok(t), reject: () => fail(new Error('read failed')) };
}

function field() {
  const state = { text: '', problem: '', keyChanges: 0 };
  const loader = createKeyFileLoader({
    setText: (t) => { state.text = t; },
    keyChanged: () => { state.keyChanges += 1; },
    setProblem: (m) => { state.problem = m; },
  }, KEY_FILE_MAX_BYTES, keyFileProblem);
  /** The user types: the field changes, then the input listener runs. */
  const type = (t: string): void => { state.text = t; loader.typed(); };
  return { state, loader, type };
}

describe('key-file reads that overlap', () => {
  it('keeps the later file when the earlier read finishes last', async () => {
    const { state, loader } = field();
    const slow = controlledFile();
    const fast = controlledFile();
    const a = loader.load(slow);
    const b = loader.load(fast);
    fast.resolve('KEY-B');
    await b;
    slow.resolve('KEY-A');
    await a;
    expect(state.text).toBe('KEY-B');
  });

  it('keeps a manual edit made while a read was running', async () => {
    const { state, loader, type } = field();
    const f = controlledFile();
    const done = loader.load(f);
    type('typed by hand');
    f.resolve('FROM-FILE');
    await done;
    expect(state.text).toBe('typed by hand');
  });

  it('a superseded read neither writes nor retires the current Compare', async () => {
    const { state, loader, type } = field();
    const f = controlledFile();
    const done = loader.load(f);
    type('x');
    const before = state.keyChanges;
    f.resolve('late');
    await done;
    expect(state.keyChanges).toBe(before);
  });

  it('a current read fills the field through keyChanged', async () => {
    const { state, loader } = field();
    const f = controlledFile();
    const done = loader.load(f);
    f.resolve('KEY');
    await done;
    expect(state.text).toBe('KEY');
    expect(state.keyChanges).toBe(1);
  });

  it('reports a failed read, unless a later load replaced it', async () => {
    const { state, loader } = field();
    const bad = controlledFile();
    const p = loader.load(bad);
    bad.reject();
    await p;
    expect(state.problem).toBe(KEY_FILE_READ_FAILED);

    const old = controlledFile();
    const fresh = controlledFile();
    const p1 = loader.load(old);
    const p2 = loader.load(fresh);
    fresh.resolve('OK');
    await p2;
    old.reject();
    await p1;
    expect(state.problem).toBe('');
    expect(state.text).toBe('OK');
  });

  it('clears the field for an oversized file and says why', async () => {
    const { state, loader } = field();
    state.text = 'old';
    await loader.load(controlledFile(KEY_FILE_MAX_BYTES + 1));
    expect(state.text).toBe('');
    expect(state.problem).toMatch(/too large/);
  });
});
