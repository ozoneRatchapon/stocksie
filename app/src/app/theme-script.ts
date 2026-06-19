// Blocking inline script applied before first paint to avoid a flash of
// wrong-theme content (FOUC). Imported by `app/layout.tsx` and injected via
// `<script dangerouslySetInnerHTML />` as the first child of `<body>`.
//
// The script reads the user's stored choice (`localStorage['stocksie-theme']`)
// and falls back to the OS-level `prefers-color-scheme` media query. Light is
// the new default (plan 007); dark is opt-in. The whole body is wrapped in a
// try/catch so a disabled localStorage / private mode never breaks the page —
// in that case the user just gets the default light theme until they toggle.
//
// IMPORTANT: keep this as a plain string (no module-level browser API access,
// no imports of React or DOM types) so it is safe to import from the
// server-rendered `layout.tsx`. The `theme.ts` hook reads the *result* of this
// script (the `.dark` class on `<html>`) after hydration; this script is the
// only thing that touches the DOM pre-hydration.

export const themeInitScript = `(function(){try{var t=localStorage.getItem('stocksie-theme');var d=window.matchMedia('(prefers-color-scheme: dark)').matches;if(t==='dark'||(!t&&d)){document.documentElement.classList.add('dark');}}catch(e){}})();`;
