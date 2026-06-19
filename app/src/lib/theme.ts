// Theme system for the Stocksie frontend — light by default (new in plan 007),
// dark as a first-class toggle. No runtime dep: the blocking inline script in
// `app/theme-script.ts` applies the chosen theme before first paint to avoid a
// flash of wrong-theme content (FOUC). This module provides the post-hydration
// API — read the current theme, set it, and a React hook that re-renders on
// change.
//
// SSR safety: `getTheme()` returns 'light' when `window` is undefined (the new
// default). The inline script corrects the actual class before paint, and
// consumers that render theme-derived UI (e.g. <ThemeToggle>) use the
// `if (!mounted) return null` mount-guard pattern so React never renders a
// theme-dependent value during SSR.

import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "stocksie-theme";
const DARK_CLASS = "dark";

/**
 * Read the active theme from `documentElement.classList`. Returns `'light'` on
 * the server (the new default). Only call from event handlers / effects after
 * mount; during SSR or initial render, use `useTheme()` + a mount guard.
 */
export function getTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return document.documentElement.classList.contains(DARK_CLASS)
    ? "dark"
    : "light";
}

/**
 * Apply a theme: toggle the `.dark` class on `<html>` and persist the choice to
 * `localStorage` so the inline script restores it on next load. No-op on the
 * server.
 *
 * The class write is the source of truth (Tailwind's `dark:` variants respond
 * to it via CSS cascade, independent of React state); `localStorage` is a
 * best-effort mirror so the inline pre-paint script knows which to restore.
 */
export function setTheme(theme: Theme): void {
  if (typeof window === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    root.classList.add(DARK_CLASS);
  } else {
    root.classList.remove(DARK_CLASS);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // localStorage may be unavailable (private mode, storage disabled) — the
    // in-memory class toggle still applies for the session.
  }
}

/**
 * React hook over the active theme. Returns the current theme, setters, and a
 * `mounted` flag.
 *
 * `theme` is `'light'` during SSR and before mount; `mounted` flips to `true`
 * inside a `useEffect` (client-only), at which point `theme` syncs to the real
 * value. Consumers that render theme-derived UI (icons, labels) must gate on
 * `mounted` to avoid hydration mismatch:
 *
 * ```tsx
 * const { theme, toggle, mounted } = useTheme();
 * if (!mounted) return null; // or a stable placeholder
 * ```
 */
export function useTheme(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
  mounted: boolean;
} {
  const [theme, setThemeState] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  // Sync state from the DOM on mount. The inline script has already applied
  // the correct class before React hydrates, so this just reflects that truth
  // into React state.
  useEffect(() => {
    setThemeState(getTheme());
    setMounted(true);
  }, []);

  const applyTheme = (next: Theme) => {
    setTheme(next);
    setThemeState(next);
  };

  // Read the source of truth (DOM) rather than potentially-stale state, so a
  // rapid double-toggle before the effect re-syncs still does the right thing.
  const toggle = () => {
    applyTheme(getTheme() === "dark" ? "light" : "dark");
  };

  return { theme, setTheme: applyTheme, toggle, mounted };
}
