// Tests for the theme system (plan 007 §A.1).
//
// Vitest runs in `environment: "node"`, so `window` / `document` /
// `localStorage` are undefined by default — this is the exact SSR condition
// we want to pin. For the client-side paths we attach minimal stubs onto
// `globalThis` and clean them up in `afterEach` so the SSR tests stay pure.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTheme, setTheme, type Theme } from "./theme";

describe("theme — SSR safety (no window)", () => {
  afterEach(() => {
    // Belt-and-braces: ensure no client globals leaked from a client test.
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("getTheme() returns 'light' when window is undefined", () => {
    expect(getTheme()).toBe("light");
  });

  it("setTheme() is a no-op when window is undefined (does not throw)", () => {
    expect(() => setTheme("dark")).not.toThrow();
    expect(() => setTheme("light")).not.toThrow();
  });
});

describe("theme — client behavior (window present)", () => {
  // Minimal DOM stubs: just enough surface for getTheme/setTheme. We model
  // `classList` as a `Set<string>` and `localStorage` as a `Map`, both on a
  // shared `documentElement` object so the two APIs agree. Casts go through
  // `unknown` because the real lib `Document` / `Storage` types are far richer
  // than our stubs — we only need the two methods each.
  let classList: Set<string>;
  let storage: Map<string, string>;
  let documentElement: {
    classList: {
      contains: (c: string) => boolean;
      add: (c: string) => void;
      remove: (c: string) => void;
    };
  };
  let localStorageStub: {
    getItem: (k: string) => string | null;
    setItem: (k: string, v: string) => void;
  };

  beforeEach(() => {
    classList = new Set();
    storage = new Map();
    documentElement = {
      classList: {
        contains: (c) => classList.has(c),
        add: (c) => {
          classList.add(c);
        },
        remove: (c) => {
          classList.delete(c);
        },
      },
    };
    localStorageStub = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => {
        storage.set(k, v);
      },
    };
    const g = globalThis as unknown as {
      window?: unknown;
      document?: { documentElement: typeof documentElement };
      localStorage?: typeof localStorageStub;
    };
    g.window = {};
    g.document = { documentElement };
    g.localStorage = localStorageStub;
  });

  afterEach(() => {
    const g = globalThis as unknown as {
      window?: unknown;
      document?: unknown;
      localStorage?: unknown;
    };
    delete g.window;
    delete g.document;
    delete g.localStorage;
  });

  it("getTheme() reads 'dark' when the .dark class is present", () => {
    classList.add("dark");
    expect(getTheme()).toBe("dark");
  });

  it("getTheme() reads 'light' when the .dark class is absent", () => {
    expect(getTheme()).toBe("light");
  });

  it("setTheme('dark') adds the .dark class and persists to localStorage", () => {
    setTheme("dark" as Theme);
    expect(classList.has("dark")).toBe(true);
    expect(storage.get("stocksie-theme")).toBe("dark");
  });

  it("setTheme('light') removes the .dark class and persists to localStorage", () => {
    classList.add("dark");
    setTheme("light" as Theme);
    expect(classList.has("dark")).toBe(false);
    expect(storage.get("stocksie-theme")).toBe("light");
  });

  it("setTheme() survives a localStorage throw (private mode) — class still toggles", () => {
    // Replace setItem with one that throws, simulating Safari private mode or
    // disabled storage. The class toggle is the source of truth and must still
    // succeed.
    localStorageStub.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => setTheme("dark")).not.toThrow();
    expect(classList.has("dark")).toBe(true);
  });
});
