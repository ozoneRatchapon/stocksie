'use client';

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

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
 * throughout. The button's own chrome ("Connect Wallet" / "Select Wallet")
 * comes from `@solana/wallet-adapter-react-ui` and is re-skinned to match in
 * Layer 2 of the web2-UX revision — see `.plans/005_web2_ux.md` §5.7.
 *
 * Kept as a thin component so the rest of the UI stays decoupled from the
 * wallet-adapter-ui package (only this file imports the button directly).
 */
export function WalletButton() {
  return <WalletMultiButton />;
}
