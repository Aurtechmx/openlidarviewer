/**
 * themes.test.ts
 *
 * Contract tests for the interface-theme registry (Blue, Field, High
 * contrast). Covers: registry stability, retired-name migration, workflow
 * name normalisation, body-class application, persistence I/O safety and
 * malformed-payload resilience.
 *
 * The default vitest environment is `node` (the project keeps its
 * tests DOM-free for speed). We stub the body element and
 * localStorage with hand-rolled minimal mocks rather than bring in
 * jsdom — the production contract only needs `classList.add/remove`
 * and the storage `get/set/clear` triad.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  applyTheme,
  isKnownThemeName,
  isThemeName,
  normalizeThemeName,
  readPersistedTheme,
  THEME_BODY_CLASS,
  THEME_HINT,
  THEME_LABEL,
  THEME_ORDER,
  THEME_STORAGE_KEY,
  writePersistedTheme,
  type ThemeBody,
  type ThemeName,
} from '../src/ui/themes';

/** A minimal stand-in for `HTMLElement` that just tracks class tokens. */
function makeBody(): ThemeBody & { classes: Set<string> } {
  const classes = new Set<string>();
  return {
    classes,
    classList: {
      add(...tokens) {
        for (const t of tokens) classes.add(t);
      },
      remove(...tokens) {
        for (const t of tokens) classes.delete(t);
      },
    },
  };
}

describe('theme registry', () => {
  it('ships exactly three theme names in stable display order', () => {
    expect(THEME_ORDER).toEqual(['dark', 'field', 'high-contrast']);
  });

  it('labels them Blue, Field and High contrast', () => {
    expect(THEME_ORDER.map((n) => THEME_LABEL[n])).toEqual(['Blue', 'Field', 'High contrast']);
  });

  it('every theme has a label, a hint, and a body class entry', () => {
    for (const name of THEME_ORDER) {
      expect(THEME_LABEL[name]).toBeTruthy();
      expect(THEME_HINT[name]).toBeTruthy();
      expect(THEME_BODY_CLASS[name]).toBeDefined();
    }
  });

  it('the dark theme uses no body class (CSS :root is its palette)', () => {
    expect(THEME_BODY_CLASS.dark).toBe('');
  });

  it('non-default themes carry a unique body class', () => {
    expect(THEME_BODY_CLASS.field).toBe('olv-theme-field');
    expect(THEME_BODY_CLASS['high-contrast']).toBe('olv-theme-high-contrast');
  });

  it('does not offer the retired light theme', () => {
    expect(THEME_ORDER).not.toContain('light');
    expect(Object.values(THEME_LABEL)).not.toContain('Light');
  });
});

describe('isThemeName — type guard', () => {
  it('accepts every active theme name', () => {
    expect(isThemeName('dark')).toBe(true);
    expect(isThemeName('field')).toBe(true);
    expect(isThemeName('high-contrast')).toBe(true);
  });

  it('does not accept the retired light name as an active theme', () => {
    expect(isThemeName('light')).toBe(false);
  });

  it('rejects unknown strings + non-strings', () => {
    expect(isThemeName('')).toBe(false);
    expect(isThemeName('Dark')).toBe(false); // case-sensitive on purpose
    expect(isThemeName('darkish')).toBe(false);
    expect(isThemeName(null)).toBe(false);
    expect(isThemeName(undefined)).toBe(false);
    expect(isThemeName(42)).toBe(false);
    expect(isThemeName({})).toBe(false);
  });
});

describe('normalizeThemeName — retired names and workflow replay', () => {
  it('keeps every active name as it is', () => {
    for (const name of THEME_ORDER) expect(normalizeThemeName(name)).toBe(name);
  });

  it('moves the retired light name to Field', () => {
    expect(normalizeThemeName('light')).toBe('field');
  });

  it('keeps High contrast as High contrast', () => {
    expect(normalizeThemeName('high-contrast')).toBe('high-contrast');
  });

  it.each([undefined, null, '', 'unknown', 'Light', 42, {}])('falls back to Blue for %s', (value) => {
    expect(normalizeThemeName(value)).toBe('dark');
  });

  it('recognises active and retired names for workflow replay, and nothing else', () => {
    for (const name of ['dark', 'field', 'high-contrast', 'light']) expect(isKnownThemeName(name)).toBe(true);
    for (const value of ['', 'midnight', 'constructor', 'toString', null, 7]) expect(isKnownThemeName(value)).toBe(false);
  });
});

describe('applyTheme — body-class swap', () => {
  it('adds the body class for a non-default theme', () => {
    const body = makeBody();
    applyTheme(body, 'field');
    expect(body.classes.has('olv-theme-field')).toBe(true);
  });

  it('removes any previous theme class when switching', () => {
    const body = makeBody();
    applyTheme(body, 'field');
    applyTheme(body, 'high-contrast');
    expect(body.classes.has('olv-theme-field')).toBe(false);
    expect(body.classes.has('olv-theme-high-contrast')).toBe(true);
  });

  it('leaves the body without any theme class for "dark"', () => {
    const body = makeBody();
    applyTheme(body, 'high-contrast');
    applyTheme(body, 'dark');
    expect(body.classes.has('olv-theme-field')).toBe(false);
    expect(body.classes.has('olv-theme-high-contrast')).toBe(false);
  });

  it('cleans a stale retired light class', () => {
    const body = makeBody();
    body.classes.add('olv-theme-light');
    applyTheme(body, 'field');
    expect([...body.classes].sort()).toEqual(['olv-theme-field']);
  });

  it('is idempotent — repeated application leaves the class once', () => {
    for (const name of THEME_ORDER) {
      const body = makeBody();
      applyTheme(body, name);
      const once = [...body.classes].sort();
      applyTheme(body, name);
      expect([...body.classes].sort()).toEqual(once);
      expect(body.classes.size).toBe(THEME_BODY_CLASS[name] ? 1 : 0);
    }
  });

  it('preserves unrelated body classes the host has set', () => {
    const body = makeBody();
    body.classes.add('host-theme-marker');
    applyTheme(body, 'high-contrast');
    expect(body.classes.has('host-theme-marker')).toBe(true);
    expect(body.classes.has('olv-theme-high-contrast')).toBe(true);
  });
});

// ── persistence tests with a localStorage stub ─────────────────────

interface StorageStub {
  store: Record<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function makeStorage(): StorageStub {
  const store: Record<string, string> = {};
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
    removeItem: (k) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
  };
}

const originalLocalStorage =
  (globalThis as { localStorage?: Storage }).localStorage;

describe('persistence — read + write', () => {
  let storage: StorageStub;

  beforeEach(() => {
    storage = makeStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    });
  });

  afterAll(() => {
    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
        writable: true,
      });
    }
  });

  it('round-trips a written theme name', () => {
    writePersistedTheme('high-contrast');
    expect(readPersistedTheme()).toBe('high-contrast');
  });

  it('returns "dark" when no value has been persisted', () => {
    expect(readPersistedTheme()).toBe('dark');
  });

  it('returns "dark" when the persisted value is malformed', () => {
    storage.setItem(THEME_STORAGE_KEY, 'midnight');
    expect(readPersistedTheme()).toBe('dark');
  });

  it('returns "dark" when the persisted value is null', () => {
    expect(readPersistedTheme()).toBe('dark');
  });

  it('round-trips every active theme', () => {
    for (const name of THEME_ORDER) {
      writePersistedTheme(name);
      expect(readPersistedTheme()).toBe(name);
    }
  });

  it('writePersistedTheme stores under the documented key', () => {
    writePersistedTheme('field');
    expect(storage.store[THEME_STORAGE_KEY]).toBe('field');
  });

  it('migrates a saved light preference to Field and rewrites it once', () => {
    storage.setItem(THEME_STORAGE_KEY, 'light');
    let writes = 0;
    const set = storage.setItem;
    storage.setItem = (k, v) => { writes += 1; set(k, v); };
    expect(readPersistedTheme()).toBe('field');
    expect(storage.store[THEME_STORAGE_KEY]).toBe('field');
    expect(readPersistedTheme()).toBe('field');
    expect(writes).toBe(1);
  });

  it('keeps a saved high-contrast preference and does not rewrite it', () => {
    storage.setItem(THEME_STORAGE_KEY, 'high-contrast');
    let writes = 0;
    storage.setItem = () => { writes += 1; };
    expect(readPersistedTheme()).toBe('high-contrast');
    expect(writes).toBe(0);
  });

  it('a malformed value is not rewritten', () => {
    storage.setItem(THEME_STORAGE_KEY, 'midnight');
    let writes = 0;
    storage.setItem = () => { writes += 1; };
    expect(readPersistedTheme()).toBe('dark');
    expect(writes).toBe(0);
  });

  it('a legacy light migration survives a storage write failure', () => {
    storage.setItem(THEME_STORAGE_KEY, 'light');
    storage.setItem = () => {
      throw new Error('Quota exceeded');
    };
    expect(readPersistedTheme()).toBe('field');
  });

  it('write does not throw when localStorage throws on setItem', () => {
    // Replace setItem with a thrower — the production code wraps
    // the call in try/catch and silently swallows.
    storage.setItem = () => {
      throw new Error('Quota exceeded');
    };
    expect(() => writePersistedTheme('field')).not.toThrow();
  });

  it('read does not throw when localStorage throws on getItem', () => {
    storage.getItem = () => {
      throw new Error('Security error');
    };
    expect(() => readPersistedTheme()).not.toThrow();
    expect(readPersistedTheme()).toBe('dark');
  });
});

describe('persistence — graceful when localStorage is undefined', () => {
  let original: Storage | undefined;

  beforeEach(() => {
    original = (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  afterAll(() => {
    if (original !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });

  it('read returns "dark" with no storage available', () => {
    expect(readPersistedTheme()).toBe('dark');
  });

  it('write is a no-op with no storage available', () => {
    expect(() => writePersistedTheme('high-contrast')).not.toThrow();
  });
});

describe('ThemeName is exhaustive at the type level', () => {
  it('covers every member of THEME_ORDER', () => {
    for (const name of THEME_ORDER) {
      const typed: ThemeName = name;
      expect(typeof typed).toBe('string');
    }
  });
});
