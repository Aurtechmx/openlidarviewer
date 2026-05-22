/**
 * xml.ts
 *
 * A minimal XML parser for the E57 schema section. E57 XML is simple and
 * well-formed — elements, attributes, text, CDATA, self-closing tags — so a
 * tiny dependency-free parser keeps the whole E57 pipeline pure and
 * Node-unit-testable (no browser `DOMParser`).
 */

/** A parsed XML element. */
export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Concatenated text / CDATA content, trimmed. */
  text: string;
}

function isSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

/** Parse a well-formed XML document into an element tree. */
export function parseXml(source: string): XmlNode {
  let i = 0;
  const n = source.length;

  const skipSpace = (): void => {
    while (i < n && isSpace(source[i])) i++;
  };

  const parseAttrs = (): Record<string, string> => {
    const attrs: Record<string, string> = {};
    for (;;) {
      skipSpace();
      const c = source[i];
      if (i >= n || c === '>' || c === '/') break;
      let key = '';
      while (i < n && !isSpace(source[i]) && !'=>/'.includes(source[i])) {
        key += source[i++];
      }
      skipSpace();
      if (source[i] === '=') {
        i++;
        skipSpace();
        const quote = source[i++];
        let value = '';
        while (i < n && source[i] !== quote) value += source[i++];
        i++; // closing quote
        attrs[key] = value;
      } else {
        attrs[key] = '';
      }
    }
    return attrs;
  };

  const parseElement = (): XmlNode => {
    i++; // consume '<'
    let name = '';
    while (i < n && !isSpace(source[i]) && source[i] !== '>' && source[i] !== '/') {
      name += source[i++];
    }
    const node: XmlNode = { name, attrs: parseAttrs(), children: [], text: '' };
    skipSpace();
    if (source[i] === '/') {
      i += 2; // '/>'
      return node;
    }
    i++; // consume '>'
    parseContent(node);
    return node;
  };

  const parseContent = (node: XmlNode): void => {
    for (;;) {
      if (i >= n) return;
      if (source[i] !== '<') {
        const next = source.indexOf('<', i);
        node.text += (next === -1 ? source.slice(i) : source.slice(i, next)).trim();
        i = next === -1 ? n : next;
        continue;
      }
      if (source.startsWith('</', i)) {
        i = source.indexOf('>', i) + 1;
        return;
      }
      if (source.startsWith('<![CDATA[', i)) {
        const end = source.indexOf(']]>', i);
        node.text += source.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (source.startsWith('<!--', i)) {
        i = source.indexOf('-->', i) + 3;
        continue;
      }
      if (source.startsWith('<?', i)) {
        i = source.indexOf('?>', i) + 2;
        continue;
      }
      node.children.push(parseElement());
    }
  };

  // Skip the prolog (declarations and comments) to reach the root element.
  for (;;) {
    skipSpace();
    if (source.startsWith('<?', i)) {
      i = source.indexOf('?>', i) + 2;
      continue;
    }
    if (source.startsWith('<!--', i)) {
      i = source.indexOf('-->', i) + 3;
      continue;
    }
    break;
  }
  if (source[i] !== '<') throw new Error('Invalid XML: no root element found.');
  return parseElement();
}

/** First direct child with the given tag name, or undefined. */
export function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((c) => c.name === name);
}

/** All direct children with the given tag name. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.name === name);
}
