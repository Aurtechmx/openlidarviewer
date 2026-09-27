/**
 * observatoryO11.mjs: the budgets and the decision rule of
 * validation/protocols/observatory-o11-v1.md, as code the benchmark driver
 * and its test both call. The constants are the protocol's; changing one is a
 * new protocol version, not an edit here.
 */

export const O11_PROTOCOL = 'validation/protocols/observatory-o11-v1.md';
export const O11_SCENARIOS = ['small', 'medium', 'large', 'stress'];
/** Budget = slicing baseline x this, for both frame time and upload bytes. */
export const O11_BUDGET_FACTOR = 1.2;
/** Instancing must be at least 10% faster: p95 <= slicing p95 x this. */
export const O11_FRAME_FACTOR = 0.9;
/** Instancing may upload at most this multiple of slicing's bytes. */
export const O11_UPLOAD_FACTOR = 1.5;

const MIB = 1024 * 1024;

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** One arm on one scenario from its runs: the median of the runs' p95s, or failed when any run failed. */
export function summariseArm(runs) {
  const failed = runs.find((r) => !r.ok);
  if (failed) return { ok: false, error: failed.error };
  return { ok: true, p95Ms: median(runs.map((r) => r.p95Ms)), uploadBytes: runs[0].uploadBytes };
}

/** Per-scenario budgets from the slicing arm, fixed before the instancing arm runs. */
export function budgetsFromSlicing(slicing) {
  const out = {};
  for (const id of O11_SCENARIOS) {
    const s = slicing[id];
    if (!s || !s.ok) throw new Error(`O11: the slicing arm has no result for ${id}; the budgets cannot be fixed`);
    out[id] = { frameMs: s.p95Ms * O11_BUDGET_FACTOR, uploadMiB: (s.uploadBytes / MIB) * O11_BUDGET_FACTOR };
  }
  return out;
}

/**
 * The verdict: instancing only if it passes both tests on every scenario.
 * Returns the chosen arm and the per-scenario reasons.
 */
export function decideO11(slicing, instancing) {
  const scenarios = {};
  let allPass = true;
  for (const id of O11_SCENARIOS) {
    const s = slicing[id];
    const i = instancing[id];
    let frame = false;
    let upload = false;
    let note = '';
    if (!i || !i.ok) {
      note = `instancing did not complete: ${i ? i.error : 'no result'}`;
    } else {
      frame = i.p95Ms <= s.p95Ms * O11_FRAME_FACTOR;
      upload = i.uploadBytes <= s.uploadBytes * O11_UPLOAD_FACTOR;
    }
    const pass = frame && upload;
    if (!pass) allPass = false;
    scenarios[id] = {
      frameRatio: i && i.ok ? i.p95Ms / s.p95Ms : null,
      uploadRatio: i && i.ok ? i.uploadBytes / s.uploadBytes : null,
      frameTest: frame,
      uploadTest: upload,
      pass,
      ...(note ? { note } : {}),
    };
  }
  return { chosen: allPass ? 'instancing' : 'slicing', scenarios };
}
