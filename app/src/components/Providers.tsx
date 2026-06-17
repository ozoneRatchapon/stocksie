'use client';

import { Buffer } from 'buffer';
import { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import type { Adapter } from '@solana/wallet-adapter-base';
import { LocalKeypairWalletAdapter } from '@/lib/adapters/localKeypairWalletAdapter';
import { RPC_ENDPOINT, RPC_COMMITMENT } from '@/lib/constants';
import '@solana/wallet-adapter-react-ui/styles.css';

// `@solana/web3.js` v1 (used by the Anchor client and wallet adapter) expects a
// global `Buffer` in the browser. Next.js 15 (webpack 5) does not polyfill Node
// built-ins automatically, so install one once on the client before any Solana
// code runs. Guards on `typeof window` keep this no-op during SSR.
if (typeof window !== 'undefined' && !(window as { Buffer?: unknown }).Buffer) {
  (window as { Buffer: typeof Buffer }).Buffer = Buffer;
}

/**
 * Root client providers for the Stocksie frontend.
 *
 * - {@link ConnectionProvider} gives every component access to the Surfpool
 *   local RPC via `useConnection()`.
 * - {@link WalletProvider} registers the wallets available in the modal:
 *     * Wallet Standard wallets (Phantom, Solflare, Backpack, …) are
 *       auto-detected by the adapter at runtime.
 *     * The custom {@link LocalKeypairWalletAdapter} provides a dev-only
 *       in-browser keypair signer so the UI is fully drivable without an
 *       installed extension.
 * - {@link WalletModalProvider} powers `<WalletMultiButton />`.
 *
 * `autoConnect` re-connects the last-used wallet on reload for smoother dev UX.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo<Adapter[]>(() => [new LocalKeypairWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ commitment: RPC_COMMITMENT }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
