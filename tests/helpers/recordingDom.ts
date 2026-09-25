/**
 * recordingDom.ts: the recording element the panel/renderer unit tests build
 * their trees against.
 *
 * The suite runs in Node with no jsdom, so `el()` needs a `document` that makes
 * elements. This stub records what was built instead of rendering it, and its
 * `textContent` getter walks the subtree, which is how a test asserts that a
 * synthesised fact actually reached the rendered tree. Holding it here keeps one
 * copy of the element shape rather than one per test file.
 *
 * Kept separate from `navBarDom.ts`: that stub models a live classList and a
 * flat `textContent`, because the NavBar tests toggle classes and read single
 * nodes. Merging the two would give each suite the other's semantics.
 */

export class RecordingEl {
  className = '';
  title = '';
  type = '';
  disabled = false;
  href = '';
  download = '';
  open = false;
  private _text = '';
  readonly attrs: Record<string, string> = {};
  readonly children: RecordingEl[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly classList = {
    add(): void { /* no-op */ },
    remove(): void { /* no-op */ },
    toggle(): void { /* no-op */ },
  };
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  set textContent(v: string) { this._text = v; }
  /** This node's own text plus every descendant's, in tree order. */
  get textContent(): string {
    return [this._text, ...this.children.map((c) => c.textContent)].filter(Boolean).join(' ');
  }
  set innerHTML(_v: string) { /* unused */ }
  append(...kids: (RecordingEl | null)[]): void {
    for (const k of kids) if (k) this.children.push(k);
  }
  replaceChildren(...kids: RecordingEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  addEventListener(): void { /* no-op */ }
  blur(): void { /* no-op */ }
  click(): void { /* no-op */ }

  /** The first node in the subtree (this one included) carrying `cls`. */
  find(cls: string): RecordingEl | null {
    if (this.className.split(/\s+/).includes(cls)) return this;
    for (const c of this.children) {
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }

  /** True when this node or any descendant carries `cls`. */
  hasClass(cls: string): boolean {
    return this.find(cls) !== null;
  }

  /** Every node in the subtree whose OWN text equals `label`. */
  findByText(label: string): RecordingEl[] {
    const out = this._text === label ? [this as RecordingEl] : [];
    for (const c of this.children) out.push(...c.findByText(label));
    return out;
  }

  /** Every class on any node in the subtree, space-split. */
  allClasses(): string[] {
    return [this.className, ...this.children.flatMap((c) => c.allClasses())]
      .flatMap((c) => c.split(/\s+/))
      .filter(Boolean);
  }

  /** Every tag name in the subtree. */
  tags(): string[] {
    return [this.tagName, ...this.children.flatMap((c) => c.tags())];
  }
}

/** Install the stub as the global `document`. Call from `beforeAll`. */
export function installRecordingDom(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new RecordingEl(tag),
  };
}
