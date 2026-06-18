import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/Providers";

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
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
