import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { themeInitScript } from "./theme-script";

export const metadata: Metadata = {
  title: "Stocksie",
  description:
    "Household coordination on Solana — vault, purchase lifecycle, and rewards.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // `suppressHydrationWarning` on <html>/<body> absorbs attributes injected by
  // browser extensions between server render and client hydration — most
  // commonly Grammarly (`data-gr-ext-installed`, `data-new-gr-c-s-check-loaded`)
  // and wallet extensions (`data-wallet*`). These mutate the DOM before React
  // hydrates and would otherwise trigger a recoverable hydration-mismatch error
  // that re-renders the whole tree on every page load. The attribute only works
  // one level deep, so it must live on the tags React renders here, not on a
  // child. See https://react.dev/reference/react-dom/components/common#suppressing-unavoidable-dom-hydration-mismatch-errors
  // The theme init script is the first child of <body> so it runs
  // synchronously before any styled content paints. It reads the user's
  // stored theme choice (or the OS `prefers-color-scheme`) and applies the
  // `.dark` class to <html> before React hydrates — this is what prevents a
  // flash of the wrong theme (FOUC). The class is the source of truth that
  // Tailwind's `dark:` variants respond to via CSS cascade.
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
