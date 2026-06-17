// Typed Anchor 1.0 client for the Stocksie program.
//
// Uses `@anchor-lang/core` (NOT `@coral-xyz/anchor`): the on-chain program is
// Anchor 1.0.2 and emits the new flat IDL format, which only the 1.0 client can
// decode. The generated `Stocksie` type lives in `./generated/stocksie` (copied
// from `target/types/stocksie.ts` by `scripts/copy-idl.mjs`) and gives full
// type-safety over `program.methods.*` and `program.account.*`.

import { AnchorProvider, Program } from '@anchor-lang/core';
import type { Connection } from '@solana/web3.js';
import { useAnchorWallet, useConnection, type AnchorWallet } from '@solana/wallet-adapter-react';
import { useMemo } from 'react';
import { idl } from './idl';
import type { Stocksie } from './generated/stocksie';

export type StocksieProgram = Program<Stocksie>;

/**
 * Build a `Program` client bound to an explicit connection + wallet.
 *
 * Used by `useProgram` and by any imperative (non-hook) caller, e.g. a one-off
 * script or an event handler that already holds a wallet reference.
 */
export function makeProgram(connection: Connection, wallet: AnchorWallet): StocksieProgram {
  const provider = new AnchorProvider(connection, wallet, AnchorProvider.defaultOptions());
  return new Program<Stocksie>(idl, provider);
}

/**
 * React hook returning a typed Stocksie program client bound to the active
 * wallet, or `null` when no wallet is connected.
 *
 * Recreates the program only when the connection or the wallet changes, so
 * downstream `useMemo`/`useEffect` deps stay stable across renders.
 */
export function useProgram(): StocksieProgram | null {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  return useMemo(
    () => (wallet ? makeProgram(connection, wallet) : null),
    [connection, wallet],
  );
}
