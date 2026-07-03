/**
 * tests/unsafeHtmlGuard.test.ts
 *
 * Static-analysis XSS guard for the `unsafeHtml` escape hatch in
 * `src/ui/dom.ts`. The `el()` helper's `unsafeHtml` prop assigns raw
 * markup via `innerHTML`; its doc contract says it may ONLY ever carry
 * trusted static text — inline SVG icon strings literally embedded in
 * the source, and chart markup the renderer composed itself from
 * numeric inputs. Never scan names, file names, URL params,
 * message-event payloads, or any other user-influenced string.
 *
 * This test makes that contract executable. It walks every `.ts` file
 * under `src/`, finds every `unsafeHtml` usage, extracts the argument
 * expression (handling template literals, nested `${}` interpolations
 * and bracketed expressions), and asserts:
 *
 *   1. Every call site matches EXACTLY ONE entry on the explicit
 *      allowlist below, and every allowlist entry claims EXACTLY ONE
 *      call site (a bijection). A new call site fails until a human
 *      reviews it and extends the allowlist; a removed call site fails
 *      until its stale entry is deleted — the list can never rot.
 *   2. No call-site argument expression — allowlisted or not — contains
 *      an identifier that smells like user data (`scanName`,
 *      `fileName`, `datasetName`, `urlParam`, `location.`,
 *      `searchParams`, `message.data`, `e.data`, `metadata.`). This is
 *      the tripwire that fires even if someone edits an already
 *      allowlisted line in place.
 *   3. The `unsafeHtml` declaration and the single `props.unsafeHtml`
 *      implementation read live in `src/ui/dom.ts` and nowhere else.
 *   4. No source file outside `dom.ts` assigns `.innerHTML` directly —
 *      raw assignments bypass the `unsafeHtml` funnel (and so all three
 *      checks above). The few reviewed-static exceptions live on
 *      RAW_INNERHTML_ALLOWLIST under the same bijection rules.
 *
 * Like the stylesheet-contract tests (analyseExportLayout) and the
 * post-build guard (chunkIsolation), this is a cheap source-text scan —
 * no parser, no build artifacts — so it runs in every plain `npm test`.
 *
 * IF THIS TEST JUST FAILED ON YOUR CHANGE: prefer safe DOM construction
 * (`el('span', { text: ... })` routes through `textContent` and escapes
 * automatically). Reach for `unsafeHtml` only for trusted static markup
 * embedded in the source — and if that is genuinely what you have,
 * extend ALLOWLIST below after review, recording why the argument is
 * static, exactly as the existing entries do.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/** The one module allowed to declare and implement the escape hatch. */
const IMPLEMENTATION_FILE = 'src/ui/dom.ts';

/**
 * Identifier patterns that mark an argument as user-influenced. Matched
 * against the RAW argument expression text (including template-literal
 * interpolations), regardless of allowlist membership.
 */
const FORBIDDEN_IDENTIFIERS =
  /scanName|fileName|datasetName|urlParam|location\.|searchParams|message\.data|e\.data|metadata\./;

/**
 * Allowlist of reviewed call sites, as `file::approximate-context`
 * entries. The context is a distinctive substring of the call-site line
 * (or its argument expression); matching is file-scoped and must be
 * one-to-one. Every entry below was hand-verified on 2026-06-10:
 *
 * - src/ui/NavBar.ts — mode-triangle outline: a zero-interpolation
 *   template literal of SVG embedded in the source.
 * - src/ui/NavBar.ts — `def.icon`: reads the module-level `MODES`
 *   const, whose `icon` fields are all literal SVG strings.
 * - src/ui/ThemeToggle.ts — `ICON_SVG[name]`: a module-level
 *   `Readonly<Record<ThemeName, string>>` of literal SVG bodies, keyed
 *   by the closed `ThemeName` union.
 * - src/ui/MeasurePanel.ts — `svg + overlay`: profile-chart markup
 *   composed in `renderProfileChart()` purely from numeric samples
 *   (`toFixed`/`Math.round` output), nice-number ticks and fixed unit
 *   strings — the "chart paths the renderer composed itself from
 *   numeric inputs" case the dom.ts contract names.
 * - src/ui/Stage.ts — `k.icon`: the local `KINDS` const of literal
 *   capture-kind SVG chips. (The former `MARK` / `HERO_MARK` inline-SVG
 *   entries are gone for good: the official brand mark renders via
 *   `<img src>` pointing at public/brand-mark.svg — a static asset URL,
 *   never `unsafeHtml` — so the top bar / hero need no allowlist entry.)
 */
const ALLOWLIST: readonly string[] = [
  'src/ui/NavBar.ts::<svg viewBox="0 0 140 110"',
  // The trailing quote pins the MODES-loop icon wrapper exactly, so it can't
  // also claim the Pan pad's `olv-mode-icon olv-mode-pan-icon` site below.
  "src/ui/NavBar.ts::olv-mode-icon'",
  // v0.5.5 P1 — the Pan pad's hand icon: `PAN_MODE.icon`, a module-level
  // literal SVG string in the same house style as the MODES icons.
  'src/ui/NavBar.ts::olv-mode-pan-icon',
  'src/ui/ThemeToggle.ts::ICON_SVG[name]',
  'src/ui/MeasurePanel.ts::svg + overlay',
  'src/ui/Stage.ts::olv-capture-chip-icon',
  // v0.4.6 icon-system pass (hand-verified 2026-06-14). Every entry below
  // injects a module-level literal SVG icon string; any accompanying label is
  // either a hardcoded literal or a static `Record` of literals — never a
  // parameter or user data. The two former parameter-label sites (toolDock
  // `_tool`, MeasureController `addAuxKindButton`) were refactored so the label
  // now goes through `text:` (escaped); only their trusted icon SVG remains on
  // unsafeHtml, as the `olv-tool-ico-glyph` / `olv-mkind-glyph` entries.
  'src/render/measure/MeasureController.ts::KIND_ICON[k]',
  'src/render/measure/MeasureController.ts::ICON_UNDO',
  'src/render/measure/MeasureController.ts::ICON_FINISH',
  'src/render/measure/MeasureController.ts::ICON_CLEAR',
  'src/render/measure/MeasureController.ts::ICON_UNITS',
  'src/render/measure/MeasureController.ts::ICON_DONE',
  'src/render/measure/MeasureController.ts::olv-mkind-glyph',
  // Snap toggle (A1, hand-verified 2026-06-20). `SNAP_ICON` is a module-level
  // literal SVG string; the label rides through a hardcoded literal span, never
  // a parameter or user data.
  'src/render/measure/MeasureController.ts::SNAP_ICON',
  'src/ui/toolDock.ts::olv-tool-ico-glyph',
  'src/ui/ClassLegendPanel.ts::ICON_SOLO',
  'src/ui/ExportPanel.ts::Export / Convert',
  'src/ui/FullscreenToggle.ts::ICON_ENTER',
  // P11 left-rail toggle: `chevron` is a hardcoded, literal static SVG string
  // (a chevron path) defined inline in wireLeftRailToggle — no user data, same
  // sanctioned pattern as the other icon SVGs above.
  'src/main.ts::cfg.chevron',
];

/**
 * Reviewed raw `.innerHTML =` assignment sites outside dom.ts, in the
 * same `file::approximate-context` form as ALLOWLIST and under the same
 * one-to-one matching. Every entry below was hand-verified on
 * 2026-06-10:
 *
 * - src/ui/NavBar.ts — `resetBtn.innerHTML`: the centre-Reset crosshair
 *   icon, a zero-interpolation template literal of SVG embedded in the
 *   source (NavBar.ts:180). Static by construction; prefer routing new
 *   markup through `el(..., { unsafeHtml })` so it lands on the main
 *   allowlist instead.
 */
const RAW_INNERHTML_ALLOWLIST: readonly string[] = [
  'src/ui/NavBar.ts::resetBtn.innerHTML',
  // src/ui/FullscreenToggle.ts — the enter/exit glyph swap in `_sync()` assigns
  // one of two module-level literal SVG constants (ICON_ENTER / ICON_EXIT).
  // Zero interpolation, no user data. (hand-verified 2026-06-14)
  'src/ui/FullscreenToggle.ts::innerHTML = fs ?',
  // src/ui/AnalysePanel.ts — the georeferencing-status glyph. The argument is
  // `georefGlyphSvg(q.crsKnown, q.datumKnown)`: a pure function of two BOOLEANS
  // that returns a fixed inline SVG (no CRS/datum names, no scan/file strings).
  // The panel's local `el()` has no unsafeHtml funnel, so the assignment is raw.
  // src/ui/AnalysePanel.ts — the Data Fitness scorecard icons. Both arguments
  // are pure functions of a closed enum key (`fitnessIcon(d.key)` /
  // `fitnessToneGlyph(d.tone)`) returning a fixed inline SVG from a module-level
  // Record of literals — no scan/file/user strings. (hand-verified 2026-06-20)
  'src/ui/AnalysePanel.ts::ico.innerHTML = fitnessIcon',
  'src/ui/AnalysePanel.ts::tone.innerHTML = fitnessToneGlyph',
];

const GUIDANCE =
  'unsafeHtml assigns raw innerHTML. Prefer safe DOM construction ' +
  "(el(tag, { text: ... }) escapes via textContent). If your markup is " +
  'genuinely trusted static source text, have it reviewed and add a ' +
  'file::approximate-context entry to ALLOWLIST in ' +
  'tests/unsafeHtmlGuard.test.ts, documenting why it is static.';

// ── Source walking ─────────────────────────────────────────────────────

/** Recursively collect every .ts file under src/, as repo-relative posix paths. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function repoRelative(absolute: string): string {
  return `src/${relative(SRC_DIR, absolute).split(sep).join('/')}`;
}

// ── Argument-expression extraction ─────────────────────────────────────

/** Skip a '…' or "…" string starting at `i`; returns index past the close. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
    } else if (text[i] === quote) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return i;
}

/** Skip a `…` template literal starting at `i`, honouring nested ${}. */
function skipTemplate(text: string, i: number): number {
  i += 1; // past the opening backtick
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
    } else if (ch === '`') {
      return i + 1;
    } else if (ch === '$' && text[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '\\') {
          i += 2;
        } else if (c === '`') {
          i = skipTemplate(text, i);
        } else if (c === "'" || c === '"') {
          i = skipString(text, i);
        } else {
          if (c === '{') depth += 1;
          if (c === '}') depth -= 1;
          i += 1;
        }
      }
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Extract the property-value expression that starts just past
 * `unsafeHtml:` — everything up to the first comma or closing brace at
 * bracket depth zero, with strings / template literals (and their
 * interpolations) consumed atomically so embedded commas don't truncate.
 */
function extractArgument(text: string, afterColon: number): string {
  let i = afterColon;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const begin = i;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      i = skipString(text, i);
    } else if (ch === '`') {
      i = skipTemplate(text, i);
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      i += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) break;
      depth -= 1;
      i += 1;
    } else if (ch === ',' && depth === 0) {
      break;
    } else {
      i += 1;
    }
  }
  return text.slice(begin, i);
}

// ── Usage scan ─────────────────────────────────────────────────────────

interface CallSite {
  file: string;
  line: number;
  /** The full source line the token sits on (context for allowlisting). */
  lineText: string;
  /** The extracted argument expression (forbidden-identifier scan target). */
  argument: string;
}

/** A raw `.innerHTML =` (or `+=`) assignment found outside dom.ts. */
interface RawInnerHtmlSite {
  file: string;
  line: number;
  lineText: string;
}

interface ScanResult {
  callSites: CallSite[];
  /** Declaration / implementation usages found OUTSIDE dom.ts — always a bug. */
  strayImplementation: string[];
  /** Direct innerHTML assignments outside dom.ts — allowlisted or a bug. */
  rawInnerHtmlSites: RawInnerHtmlSite[];
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

function lineTextAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end === -1 ? text.length : end).trim();
}

function scanSources(): ScanResult {
  const callSites: CallSite[] = [];
  const strayImplementation: string[] = [];
  const rawInnerHtmlSites: RawInnerHtmlSite[] = [];

  for (const absolute of listSourceFiles(SRC_DIR)) {
    const file = repoRelative(absolute);
    const text = readFileSync(absolute, 'utf8');

    // Raw `.innerHTML = …` / `.innerHTML += …` assignments bypass the
    // unsafeHtml funnel entirely. dom.ts hosts the one sanctioned
    // assignment (the funnel itself, pinned by the implementation test
    // below); everything else must be allowlisted. The `(?!=)` keeps
    // equality comparisons (`=== `/`!==`) out of the net.
    if (file !== IMPLEMENTATION_FILE) {
      const assign = /\.innerHTML\s*\+?=(?!=)/g;
      for (let m = assign.exec(text); m !== null; m = assign.exec(text)) {
        rawInnerHtmlSites.push({
          file,
          line: lineOf(text, m.index),
          lineText: lineTextAt(text, m.index),
        });
      }
    }

    const token = /\bunsafeHtml\b/g;
    for (let m = token.exec(text); m !== null; m = token.exec(text)) {
      const before = text[m.index - 1];
      const afterIdx = m.index + m[0].length;
      const rest = text.slice(afterIdx);
      const where = `${file}:${lineOf(text, m.index)}`;

      if (before === '.') {
        // Member read (`props.unsafeHtml`) — implementation-only.
        if (file !== IMPLEMENTATION_FILE) strayImplementation.push(where);
        continue;
      }
      if (/^\?\s*:/.test(rest)) {
        // Optional-property declaration (`unsafeHtml?: string`) — ditto.
        if (file !== IMPLEMENTATION_FILE) strayImplementation.push(where);
        continue;
      }
      const colon = rest.match(/^\s*:/);
      if (colon) {
        // Property call site: `el(tag, { unsafeHtml: <expr> })`.
        callSites.push({
          file,
          line: lineOf(text, m.index),
          lineText: lineTextAt(text, m.index),
          argument: extractArgument(text, afterIdx + colon[0].length),
        });
        continue;
      }
      if (/^\s*[,}=(]/.test(rest)) {
        // Shorthand (`{ unsafeHtml }`), destructuring, reassignment, or a
        // call form — treat as a call site whose "argument" is opaque; it
        // can never match the allowlist contexts, so it fails with the
        // guidance message and forces a human review.
        callSites.push({
          file,
          line: lineOf(text, m.index),
          lineText: lineTextAt(text, m.index),
          argument: lineTextAt(text, m.index),
        });
        continue;
      }
      // Anything else (prose in a comment, an unrelated identifier
      // fragment) is not a usage — ignore.
    }
  }
  return { callSites, strayImplementation, rawInnerHtmlSites };
}

// ── The contract ───────────────────────────────────────────────────────

describe('unsafeHtml static-analysis guard (src/ui/dom.ts contract)', () => {
  const { callSites, strayImplementation, rawInnerHtmlSites } = scanSources();

  it('the unsafeHtml declaration and innerHTML assignment live only in dom.ts', () => {
    expect(
      strayImplementation,
      `unsafeHtml declaration/member-read found outside ${IMPLEMENTATION_FILE}: ` +
        `${strayImplementation.join(', ')} — the escape hatch must have exactly ` +
        'one implementation.',
    ).toEqual([]);
    const dom = readFileSync(join(SRC_DIR, 'ui', 'dom.ts'), 'utf8');
    expect(dom).toMatch(/unsafeHtml\?\s*:\s*string/);
    expect(dom).toMatch(/node\.innerHTML = props\.unsafeHtml/);
  });

  it('no call-site argument references user-data-shaped identifiers', () => {
    const offenders = callSites
      .filter((site) => FORBIDDEN_IDENTIFIERS.test(site.argument))
      .map((site) => `${site.file}:${site.line} — ${site.lineText}`);
    expect(
      offenders,
      `unsafeHtml argument references a user-influenced identifier ` +
        `(matched ${String(FORBIDDEN_IDENTIFIERS)}):\n${offenders.join('\n')}\n` +
        `This fails regardless of the allowlist. ${GUIDANCE}`,
    ).toEqual([]);
  });

  it('every unsafeHtml call site is on the reviewed allowlist, one-to-one', () => {
    const entries = ALLOWLIST.map((raw) => {
      const split = raw.indexOf('::');
      return { raw, file: raw.slice(0, split), context: raw.slice(split + 2) };
    });

    // Claim pass: each call site must be matched by exactly one entry,
    // and each entry must claim exactly one call site.
    const claims = new Map<string, CallSite[]>();
    for (const entry of entries) claims.set(entry.raw, []);

    const unmatched: string[] = [];
    for (const site of callSites) {
      const siteText = `${site.lineText}\n${site.argument}`;
      const matches = entries.filter(
        (entry) => entry.file === site.file && siteText.includes(entry.context),
      );
      if (matches.length === 1) {
        claims.get(matches[0].raw)!.push(site);
      } else if (matches.length === 0) {
        unmatched.push(`${site.file}:${site.line} — ${site.lineText}`);
      } else {
        unmatched.push(
          `${site.file}:${site.line} — matched ${matches.length} allowlist ` +
            'entries (contexts must be unambiguous): ' +
            matches.map((entry) => entry.raw).join(' | '),
        );
      }
    }
    expect(
      unmatched,
      `unreviewed (or ambiguous) unsafeHtml call site(s):\n${unmatched.join('\n')}\n${GUIDANCE}`,
    ).toEqual([]);

    const overclaimed = entries.filter((entry) => claims.get(entry.raw)!.length > 1);
    expect(
      overclaimed.map((entry) => entry.raw),
      'an allowlist entry matched MORE THAN ONE call site — a new call site is ' +
        'hiding behind an existing approval. Make each context distinctive and ' +
        'add one entry per reviewed site.',
    ).toEqual([]);

    const stale = entries.filter((entry) => claims.get(entry.raw)!.length === 0);
    expect(
      stale.map((entry) => entry.raw),
      'stale allowlist entr(ies) matched no call site — the code moved or was ' +
        'removed. Delete or update the entry so the list stays a faithful ' +
        'review record.',
    ).toEqual([]);

    // Belt-and-braces: the bijection above implies this, but state it
    // plainly so a failure mode is obvious in the report.
    expect(callSites.length).toBe(ALLOWLIST.length);
  });

  it('no raw .innerHTML assignment exists outside dom.ts (allowlist, one-to-one)', () => {
    const entries = RAW_INNERHTML_ALLOWLIST.map((raw) => {
      const split = raw.indexOf('::');
      return { raw, file: raw.slice(0, split), context: raw.slice(split + 2) };
    });

    const claims = new Map<string, RawInnerHtmlSite[]>();
    for (const entry of entries) claims.set(entry.raw, []);

    const unmatched: string[] = [];
    for (const site of rawInnerHtmlSites) {
      const matches = entries.filter(
        (entry) => entry.file === site.file && site.lineText.includes(entry.context),
      );
      if (matches.length === 1) {
        claims.get(matches[0].raw)!.push(site);
      } else if (matches.length === 0) {
        unmatched.push(`${site.file}:${site.line} — ${site.lineText}`);
      } else {
        unmatched.push(
          `${site.file}:${site.line} — matched ${matches.length} allowlist ` +
            'entries (contexts must be unambiguous): ' +
            matches.map((entry) => entry.raw).join(' | '),
        );
      }
    }
    expect(
      unmatched,
      `raw .innerHTML assignment(s) outside ${IMPLEMENTATION_FILE}:\n` +
        `${unmatched.join('\n')}\n` +
        'Direct innerHTML assignments bypass the unsafeHtml funnel and every ' +
        `check in this guard. ${GUIDANCE} For a genuinely static raw ` +
        'assignment, add a file::approximate-context entry to ' +
        'RAW_INNERHTML_ALLOWLIST instead.',
    ).toEqual([]);

    const overclaimed = entries.filter((entry) => claims.get(entry.raw)!.length > 1);
    expect(
      overclaimed.map((entry) => entry.raw),
      'a RAW_INNERHTML_ALLOWLIST entry matched MORE THAN ONE assignment — a ' +
        'new site is hiding behind an existing approval. Make each context ' +
        'distinctive and add one entry per reviewed site.',
    ).toEqual([]);

    const stale = entries.filter((entry) => claims.get(entry.raw)!.length === 0);
    expect(
      stale.map((entry) => entry.raw),
      'stale RAW_INNERHTML_ALLOWLIST entr(ies) matched no assignment — the ' +
        'code moved or was removed. Delete or update the entry so the list ' +
        'stays a faithful review record.',
    ).toEqual([]);

    expect(rawInnerHtmlSites.length).toBe(RAW_INNERHTML_ALLOWLIST.length);
  });
});
