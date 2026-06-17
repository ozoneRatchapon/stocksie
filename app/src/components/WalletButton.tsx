'use client';

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
  return <BaseWalletMultiButton labels={WALLET_BUTTON_LABELS} />;
}
