'use client';

import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';

/**
 * Stocksie wrapper around the wallet-adapter multi-button.
 *
 * Renders the connect / disconnect control and the wallet-picker modal
 * trigger. The modal lists every adapter registered with `WalletProvider`:
 * Wallet Standard wallets (Phantom, Solflare, Backpack, ...) that are
 * auto-detected by the provider, plus the built-in `LocalKeypairWalletAdapter`
 * for dev-only signing when no browser extension is present.
 *
 * Kept as a thin component so the rest of the UI stays decoupled from the
 * wallet-adapter-ui package (only this file imports the button directly).
 */
export function WalletButton() {
  return <WalletMultiButton />;
}
