/**
 * themes.test.ts
 *
 * Contract tests for the v0.3.9 theme system pure-data module.
 * Covers: registry stability, body-class application, persistence
 * I/O safety, malformed-payload resilience.
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
  isThemeName,
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
    expect(THEME_ORDER).toEqual(['dark', 'light', 'high-contrast']);
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
    const light = THEME_BODY_CLASS.light;
    const hc = THEME_BODY_CLASS['high-contrast'];
    expect(light).toBeTruthy();
    expect(hc).toBeTruthy();
    expect(light).not.toBe(hc);
  });
});

describe('isThemeName — type guard', () => {
  it('accepts every known theme name', () => {
    expect(isThemeName('dark')).toBe(true);
    expect(isThemeName('light')).toBe(true);
    expect(isThemeName('high-contrast')).toBe(true);
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

describe('applyTheme — body-class swap', () => {
  it('adds the body class for a non-default theme', () => {
    const body = makeBody();
    applyTheme(body, 'light');
    expect(body.classes.has('olv-theme-light')).toBe(true);
  });

  it('removes any previous theme class when switching', () => {
    const body = makeBody();
    applyTheme(body, 'light');
    applyTheme(body, 'high-contrast');
    expect(body.classes.has('olv-theme-light')).toBe(false);
    expect(body.classes.has('olv-theme-high-contrast')).toBe(true);
  });

  it('leaves the body without any theme class for "dark"', () => {
    const body = makeBody();
    applyTheme(body, 'light');
    applyTheme(body, 'dark');
    expect(body.classes.has('olv-theme-light')).toBe(false);
    expect(body.classes.has('olv-theme-high-contrast')).toBe(false);
  });

  it('is idempotent — repeated application leaves the class once', () => {
    const body = makeBody();
    applyTheme(body, 'light');
    applyTheme(body, 'light');
    const matches = Array.from(body.classes).filter(
      (c) => c === 'olv-theme-light',
    );
    expect(matches.length).toBe(1);
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

  it('writePersistedTheme stores under the documented key', () => {
    writePersistedTheme('light');
    expect(storage.store[THEME_STORAGE_KEY]).toBe('light');
  });

  it('write does not throw when localStorage throws on setItem', () => {
    // Replace setItem with a thrower — the production code wraps
    // the call in try/catch and silently swallows.
    storage.setItem = () => {
      throw new Error('Quota exceeded');
    };
    expect(() => writePersistedTheme('light')).not.toThrow();
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
