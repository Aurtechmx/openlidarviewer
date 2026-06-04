/** Tiny DOM helpers — keeps the UI modules free of repetitive boilerplate. */

interface ElProps {
  className?: string;
  text?: string;
  /**
   * RAW HTML / SVG markup, assigned verbatim via `innerHTML`. The
   * deliberately-ugly name makes call sites stand out: using this option
   * asserts "the markup I'm passing is trusted static text, NOT
   * user-derived". Never pass scan names, file
   * names, URL params, message-event payloads, or any other
   * user-influenced string here — those must use `text` (which
   * routes through `textContent` and escapes automatically) or a
   * dedicated escaping helper.
   *
   * The valid uses today are: inline SVG icon strings literally
   * embedded in the source, and chart paths the renderer composed
   * itself from numeric inputs.
   */
  unsafeHtml?: string;
  title?: string;
  href?: string;
  type?: string;
  ariaLabel?: string;
}

/** Create an element with optional props and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.unsafeHtml !== undefined) node.innerHTML = props.unsafeHtml;
  if (props.title) node.title = props.title;
  if (props.ariaLabel) node.setAttribute('aria-label', props.ariaLabel);
  if (props.href && node instanceof HTMLAnchorElement) node.href = props.href;
  if (props.type && node instanceof HTMLInputElement) node.type = props.type;
  for (const child of children) node.append(child);
  return node;
}

/** Format a point count compactly: 4_200_000 → "4.2M", 1_100 → "1.1K". */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
