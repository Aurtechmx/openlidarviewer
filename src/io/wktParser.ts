/**
 * wktParser.ts
 *
 * A small, dependency-free tokenizer + recursive parser for OGC WKT
 * (Well-Known Text) coordinate-reference-system strings. It turns a WKT string
 * into an AST of `KEYWORD["name", child, child, …]` nodes so callers can read
 * fields by STRUCTURE (a node's keyword, its direct children, per-axis units)
 * instead of by regex — which cannot tell a CRS's own `AUTHORITY` from one
 * nested in a `UNIT` or `DATUM`, and bleeds a compound's vertical clauses into
 * the horizontal read.
 *
 * Scope is deliberately narrow: recognise the WKT grammar's four token kinds
 * (quoted string, number, bare keyword/identifier, bracketed node) and nest
 * them. No semantics live here — `crs.ts` maps the AST to a `CrsInfo`. The
 * parser NEVER throws: malformed input yields a best-effort tree (or `null`
 * when no node can be found), so a broken VLR degrades to the same fallback a
 * regex miss would, rather than crashing the loader.
 *
 * Both WKT1 (`PROJCS`, `AUTHORITY["EPSG","32612"]`) and WKT2 (`PROJCRS`,
 * `ID["EPSG",32612]`, `BASEGEOGCRS`, `LENGTHUNIT`) shapes tokenise identically
 * because the grammar is the same; only the keyword spellings differ, and
 * keyword interpretation is the caller's job.
 */

// ─────────────────────────────────────────────────────────────────────────────
// AST node shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A child of a WKT node — one of the grammar's value kinds:
 *   • `node`    — a nested `KEYWORD[…]` (e.g. a `GEOGCS` inside a `PROJCS`)
 *   • `string`  — a quoted string (`"WGS 84"`); this is how names arrive
 *   • `number`  — a numeric literal (`0.9996`, `-111`, `298.257223563`)
 *   • `keyword` — a bare unquoted identifier that is NOT followed by `[`
 *                 (e.g. an axis direction `UP` / `NORTH`, or `NONE`)
 */
export type WktChild =
  | { readonly type: 'node'; readonly node: WktNode }
  | { readonly type: 'string'; readonly value: string }
  | { readonly type: 'number'; readonly value: number }
  | { readonly type: 'keyword'; readonly value: string };

/** A parsed `KEYWORD[ … ]` clause. */
export interface WktNode {
  /** The clause keyword, UPPERCASED for case-insensitive matching (`'PROJCS'`). */
  readonly keyword: string;
  /**
   * Source index of the keyword's first character. Gives every node a stable
   * document-order position — used to reproduce the old parser's "everything
   * before the first vertical keyword is the horizontal slice" rule exactly.
   */
  readonly start: number;
  /** The clause's children, in source order. */
  readonly children: readonly WktChild[];
}

/** Cap on nesting depth — real WKT nests < ~10 deep; this only guards against a
 * pathological/malformed input blowing the stack. Content deeper than this is
 * skipped rather than parsed. */
const MAX_DEPTH = 64;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a WKT string into its root node, or `null` when the input contains no
 * `KEYWORD[…]` node at all (empty, whitespace, or pure junk). Never throws.
 */
export function parseWkt(src: string): WktNode | null {
  return parseTokens(tokenize(src));
}

/** Pre-order (document-order) list of every node in the tree, root first. */
export function collectWktNodes(root: WktNode): WktNode[] {
  const out: WktNode[] = [];
  const visit = (n: WktNode): void => {
    out.push(n);
    for (const c of n.children) if (c.type === 'node') visit(c.node);
  };
  visit(root);
  return out;
}

/** The node's direct child nodes (skipping scalar children), in source order. */
export function wktChildNodes(node: WktNode): WktNode[] {
  const out: WktNode[] = [];
  for (const c of node.children) if (c.type === 'node') out.push(c.node);
  return out;
}

/**
 * The node's NAME: the first child, only when it is a quoted string. WKT places
 * the name immediately after the opening bracket (`KEYWORD["name", …]`), so a
 * node whose first child is not a string has no name — matching the old
 * `KEYWORD\s*\[\s*"…"` regex, which required the quote right after the bracket.
 */
export function wktNodeName(node: WktNode): string | undefined {
  const first = node.children[0];
  return first?.type === 'string' ? first.value : undefined;
}

/** The node's first numeric child, or `undefined` when it has none. */
export function wktFirstNumber(node: WktNode): number | undefined {
  for (const c of node.children) if (c.type === 'number') return c.value;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

type Tok =
  | { readonly t: 'lb'; readonly i: number }
  | { readonly t: 'rb'; readonly i: number }
  | { readonly t: 'comma'; readonly i: number }
  | { readonly t: 'string'; readonly v: string; readonly i: number }
  | { readonly t: 'number'; readonly n: number; readonly i: number }
  | { readonly t: 'ident'; readonly v: string; readonly i: number };

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

/** A number begins with a digit, or a sign/dot immediately followed by a digit. */
function isNumberStart(src: string, i: number): boolean {
  const ch = src[i];
  if (isDigit(ch)) return true;
  if (ch === '-' || ch === '+' || ch === '.') {
    const d = src[i + 1];
    return d !== undefined && isDigit(d);
  }
  return false;
}

/** Characters that may continue a numeric literal — mirrors the old scale
 * regex's `[0-9.eE+-]+` so a token parses to the same `Number(…)`. */
function isNumberChar(ch: string): boolean {
  return isDigit(ch) || ch === '.' || ch === 'e' || ch === 'E' || ch === '+' || ch === '-';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isIdentChar(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const ch = src[i];
    // Whitespace.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    if (ch === '[') { out.push({ t: 'lb', i }); i++; continue; }
    if (ch === ']') { out.push({ t: 'rb', i }); i++; continue; }
    if (ch === ',') { out.push({ t: 'comma', i }); i++; continue; }
    if (ch === '"') {
      // Quoted string — read to the next quote (or end). Matches the old
      // `[^"]+` captures; WKT names never contain a literal quote.
      const start = i + 1;
      let j = start;
      while (j < len && src[j] !== '"') j++;
      out.push({ t: 'string', v: src.slice(start, j), i });
      i = j < len ? j + 1 : j;
      continue;
    }
    if (isNumberStart(src, i)) {
      let j = i + 1;
      while (j < len && isNumberChar(src[j])) j++;
      out.push({ t: 'number', n: Number(src.slice(i, j)), i });
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentChar(src[j])) j++;
      out.push({ t: 'ident', v: src.slice(i, j), i });
      i = j;
      continue;
    }
    // Any other character (stray punctuation) — skip it rather than fail.
    i++;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

function parseTokens(tokens: Tok[]): WktNode | null {
  let pos = 0;

  /** Consume a balanced bracket block starting at an `ident [` or a bare `[`. */
  const skipBlock = (): void => {
    if (tokens[pos]?.t === 'ident') pos++;
    if (tokens[pos]?.t !== 'lb') {
      if (pos < tokens.length) pos++;
      return;
    }
    let depth = 0;
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.t === 'lb') depth++;
      else if (t.t === 'rb') {
        depth--;
        if (depth === 0) { pos++; return; }
      }
      pos++;
    }
  };

  /** Parse `IDENT [ child (, child)* ]` — assumes tokens[pos] is the keyword. */
  const parseNode = (depth: number): WktNode | null => {
    const idTok = tokens[pos];
    if (idTok?.t !== 'ident') return null;
    const lb = tokens[pos + 1];
    if (lb?.t !== 'lb') return null;

    const keyword = idTok.v;
    const start = idTok.i;
    pos += 2; // consume the keyword and its opening bracket

    const children: WktChild[] = [];
    while (pos < tokens.length) {
      const tk = tokens[pos];
      if (tk.t === 'rb') { pos++; break; } // close this node
      if (tk.t === 'comma') { pos++; continue; }
      if (tk.t === 'string') { children.push({ type: 'string', value: tk.v }); pos++; continue; }
      if (tk.t === 'number') { children.push({ type: 'number', value: tk.n }); pos++; continue; }
      if (tk.t === 'lb') { skipBlock(); continue; } // stray bracket — skip its block
      // ident: a nested node when followed by '[', otherwise a bare keyword token.
      const nxt = tokens[pos + 1];
      if (nxt?.t === 'lb') {
        if (depth < MAX_DEPTH) {
          const child = parseNode(depth + 1);
          if (child) children.push({ type: 'node', node: child });
          else skipBlock();
        } else {
          skipBlock();
        }
      } else {
        children.push({ type: 'keyword', value: tk.v });
        pos++;
      }
    }

    return { keyword: keyword.toUpperCase(), start, children };
  };

  // Find the first top-level `IDENT [` and parse it as the root.
  while (pos < tokens.length) {
    const tk = tokens[pos];
    if (tk.t === 'ident' && tokens[pos + 1]?.t === 'lb') {
      return parseNode(0);
    }
    pos++;
  }
  return null;
}
