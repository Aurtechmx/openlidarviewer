/** Tiny DOM helpers — keeps the UI modules free of repetitive boilerplate. */

interface ElProps {
  className?: string;
  text?: string;
  html?: string;
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
  if (props.html !== undefined) node.innerHTML = props.html;
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
