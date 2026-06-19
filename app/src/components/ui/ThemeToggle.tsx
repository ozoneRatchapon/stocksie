"use client";

// ThemeToggle — a small icon button that flips between light and dark themes.
//
// Uses the `useTheme()` hook (lib/theme.ts). The icon shown depends on the
// *current* theme (show the moon in light mode to switch *to* dark, the sun in
// dark mode to switch *to* light), which means it is theme-derived — so the
// component must NOT render its real icon during SSR / before mount, or React
// would render a different icon than the inline pre-paint script has already
// themed the page for (a hydration mismatch).
//
// The mount-guard pattern (`if (!mounted) return <placeholder/>`) returns a
// stable, same-size skeleton button during SSR + pre-mount so the header row
// never shifts when the real toggle swaps in. This is the same pattern
// `WalletButton.tsx` uses for the wallet button.

import { useTheme } from "@/lib/theme";

export function ThemeToggle() {
  const { theme, toggle, mounted } = useTheme();

  // Pre-mount placeholder: same dimensions + chrome as the real button so the
  // header layout is identical server-side and client-side. No icon yet.
  if (!mounted) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-stone-200 bg-white dark:border-slate-700 dark:bg-slate-800"
      />
    );
  }

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-stone-200 bg-white text-stone-600 transition-colors hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
    >
      {/* Sun icon shows in dark mode (click to go light); moon shows in light
          mode (click to go dark). SVGs are aria-hidden because the button's
          accessible name comes from aria-label above. */}
      {isDark ? (
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg
          className="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
