"use client";

import { useEffect, useState } from "react";
import { BaseWalletMultiButton } from "@solana/wallet-adapter-react-ui";

/**
 * Stocksie wrapper around the wallet-adapter multi-button — the app's
 * "sign in" control.
 *
 * Renders the sign-in / sign-out control and the wallet-picker modal trigger.
 * The modal lists every adapter registered with `WalletProvider`: Wallet
 * Standard wallets (Phantom, Solflare, Backpack, ...) that are auto-detected
 * by the provider, plus the built-in `LocalKeypairWalletAdapter` for dev-only
 * signing when no browser extension is present.
 *
 * The surrounding Stocksie UI uses "sign in" / "your account" vocabulary
 * throughout. The button's own chrome (colours, borders, the connected-state
 * address display) comes from `@solana/wallet-adapter-react-ui` and is fully
 * re-skinned in Layer 2 of the web2-UX revision — see `.plans/005_web2_ux.md`
 * §5.7. The button's *labels*, however, are overridable via the first-class
 * `labels` prop on `BaseWalletMultiButton`, so Layer 1 (this file) swaps the
 * default "Select Wallet" / "Disconnect" / "Change wallet" strings for the
 * household-friendly ones below. We therefore render `BaseWalletMultiButton`
 * directly instead of the exported `WalletMultiButton`, which hardcodes its
 * own `LABELS` and ignores any override.
 *
 * Kept as a thin component so the rest of the UI stays decoupled from the
 * wallet-adapter-ui package (only this file imports the button directly).
 */
const WALLET_BUTTON_LABELS = {
  // Trigger copy (no wallet connected / wallet detected but not connected).
  "no-wallet": "Sign in",
  "has-wallet": "Sign in",
  connecting: "Signing in…",
  // Connected-state dropdown menu items.
  "copy-address": "Copy address",
  copied: "Copied",
  "change-wallet": "Switch account",
  disconnect: "Sign out",
} as const;

export function WalletButton() {
  // `BaseWalletMultiButton` depends on Wallet Standard detection
  // (`window.solana` / `window.phantom.*` etc.) which only runs in the
  // browser. During SSR no wallets are detected, so it renders the bare
  // "Sign in" label; on the client's first render, Wallet Standard fires and
  // the button flips to its `ready` state with the `<i class="wallet-adapter-
  // button-start-icon">` slot — a genuine server/client divergence that
  // triggers a hydration-mismatch error (and a full tree re-render) on every
  // page load. `suppressHydrationWarning` can't fix it because the mismatch is
  // deep in the button subtree, not on a tag we render.
  //
  // The standard Solana dApp fix: gate the render on a `mounted` flag that
  // flips in `useEffect`. SSR renders `null`; the client's first render also
  // renders `null` (matching the server, no mismatch); then `useEffect` runs,
  // `mounted` becomes true, and the real button appears. The ~1-frame gap is
  // imperceptible and beats a console error + full subtree re-render on every
  // navigation.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return <BaseWalletMultiButton labels={WALLET_BUTTON_LABELS} />;
}
