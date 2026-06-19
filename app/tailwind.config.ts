import type { Config } from "tailwindcss";

const config: Config = {
  // `class` strategy so the theme toggle (plan 007) controls dark mode by
  // toggling `.dark` on <html>. The inline pre-paint script in
  // `app/theme-script.ts` sets the class before hydration, and `useTheme()`
  // (lib/theme.ts) toggles it post-hydration. The default `media` strategy
  // would ignore the toggle and follow only the OS setting.
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
