/**
 * objectPanelDom.ts — the DOM stub the Object/Space panel tests share.
 *
 * ObjectPanel asserts on RENDERED text, so this stub's `textContent` flattens
 * its children, which the general `measurePanelDom` FakeEl does not do. Three
 * test files had declared it independently, which Sonar counted as duplicated
 * lines on every new object-panel test.
 */
export class FakeEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  private _text = '';
  readonly children: FakeEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly classList = { toggle(): void { /* no-op */ }, remove(): void { /* no-op */ } };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(): void { /* no-op */ }
  removeAttribute(): void { /* no-op */ }
  set textContent(v: string) { this._text = v; }
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  append(...kids: FakeEl[]): void { this.children.push(...kids); }
  replaceChildren(...kids: FakeEl[]): void { this.children.length = 0; this.children.push(...kids); }
  /** Every node in this subtree whose own text equals `label`. */
  findByText(label: string): FakeEl[] {
    const out: FakeEl[] = [];
    if (this._text === label) out.push(this);
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }
  addEventListener(): void { /* no-op */ }
}

/** Every title/hint string in the rendered tree, joined. */
export function allTitles(root: FakeEl, acc: string[] = []): string[] {
  if (root.title) acc.push(root.title);
  for (const c of root.children) allTitles(c, acc);
  return acc;
}
