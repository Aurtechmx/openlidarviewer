/**
 * cspInline.mjs: compare a page's inline <script> and <style> blocks with the
 * Content-Security-Policy that ships with it.
 *
 * An inline block runs under a policy only if the policy names it: by the
 * block's hash, by a nonce the block carries, or by 'unsafe-inline' when the
 * policy has no hash or nonce (a browser ignores 'unsafe-inline' once either is
 * present). A policy that lists SOME hash does not allow every block, so each
 * block's hash is computed and looked up. Treating "the policy contains a
 * sha256 source" as "inline is fine" let a page ship a style whose hash was
 * missing: it rendered unstyled under the shipped policy and nothing said so.
 */

import { createHash } from 'node:crypto';

import { matchesOutsideComments } from './htmlComments.mjs';

const ALGORITHMS = ['sha256', 'sha384', 'sha512'];

/** `'sha256-<base64>'`, the CSP source for `text` as the browser hashes it. */
export function hashSource(text, algorithm = 'sha256') {
  return `'${algorithm}-${createHash(algorithm).update(text, 'utf8').digest('base64')}'`;
}

/** Directive name to its source list. */
export function parsePolicy(policy) {
  const directives = new Map();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/** The source list that governs `directive`, falling back as a browser does. */
export function governingSources(directives, directive) {
  const base = directive.replace(/-(elem|attr)$/, '');
  return directives.get(directive) ?? directives.get(base) ?? directives.get('default-src') ?? [];
}

const DATA_SCRIPT_TYPE = /json|template|text\/plain|speculationrules/i;

/**
 * The inline blocks of one tag outside comments: `{ text, attrs }`. A script
 * with a `src` is external and a script of a data type is never executed, so
 * neither is a block.
 */
export function inlineBlocks(html, tag) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}\\s*>`, 'gi');
  return matchesOutsideComments(html, pattern)
    .map((m) => ({ attrs: m[1], text: m[2] }))
    .filter((b) => {
      if (tag !== 'script') return true;
      if (/\bsrc\s*=/i.test(b.attrs)) return false;
      const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(b.attrs);
      return !(type && DATA_SCRIPT_TYPE.test(type[1]));
    });
}

function nonceOf(attrs) {
  const m = /\bnonce\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** Whether `sources` allow one inline block, and why not when they do not. */
export function blockVerdict(sources, block) {
  const pinned = sources.some((s) => /^'(?:sha(?:256|384|512)-|nonce-)/i.test(s));
  if (!pinned) {
    return sources.includes("'unsafe-inline'")
      ? { ok: true }
      : { ok: false, hash: hashSource(block.text) };
  }
  const nonce = nonceOf(block.attrs);
  if (nonce && sources.includes(`'nonce-${nonce}'`)) return { ok: true };
  const hashes = ALGORITHMS.map((a) => hashSource(block.text, a));
  if (hashes.some((h) => sources.includes(h))) return { ok: true };
  return { ok: false, hash: hashes[0] };
}

const HANDLER = /<[a-z][^>]*?\son[a-z]+\s*=/gi;
const JAVASCRIPT_URL = /\b(?:src|href)\s*=\s*(?:"\s*javascript:|'\s*javascript:|javascript:)/gi;

/**
 * One line per way `html` fails `policy` (a header value): an inline <script>
 * or <style> whose hash the policy does not list, an inline event handler, a
 * `javascript:` URL.
 */
export function inlineProblems(file, html, policy) {
  const directives = parsePolicy(policy);
  const problems = [];

  const scriptSources = governingSources(directives, 'script-src-elem');
  for (const block of inlineBlocks(html, 'script')) {
    const v = blockVerdict(scriptSources, block);
    if (!v.ok) {
      problems.push(
        `${file}: inline <script> with hash ${v.hash} is not allowed by script-src. ` +
          'Move the code to its own file and load it with src.',
      );
    }
  }

  const styleSources = governingSources(directives, 'style-src-elem');
  for (const block of inlineBlocks(html, 'style')) {
    const v = blockVerdict(styleSources, block);
    if (!v.ok) {
      problems.push(
        `${file}: inline <style> with hash ${v.hash} is not allowed by style-src. ` +
          'Move it to a stylesheet and load it with <link>, or add the hash to the policy.',
      );
    }
  }

  const attrSources = governingSources(directives, 'script-src-attr');
  const handlersAllowed =
    attrSources.includes("'unsafe-hashes'") ||
    (attrSources.includes("'unsafe-inline'") && !attrSources.some((s) => /^'(?:sha|nonce-)/i.test(s)));
  if (!handlersAllowed) {
    const handlers = matchesOutsideComments(html, HANDLER).length;
    if (handlers > 0) {
      problems.push(
        `${file}: ${handlers} inline event handler attribute(s), which script-src refuses. ` +
          'Attach the listener from the external script instead.',
      );
    }
    const jsUrls = matchesOutsideComments(html, JAVASCRIPT_URL).length;
    if (jsUrls > 0) {
      problems.push(
        `${file}: ${jsUrls} javascript: URL(s) in src or href, which script-src refuses. ` +
          'Use a real URL and handle the click from the external script.',
      );
    }
  }
  return problems;
}
