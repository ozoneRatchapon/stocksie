"use client";

// Dev-only signer fallback for the Stocksie frontend.
//
// wallet-adapter normally drives signing through a browser extension
// (Phantom, Solflare, Backpack, ...) registered via the Wallet Standard. When
// no such extension is present — common when iterating against a local
// Surfpool validator — this adapter exposes an in-browser `Keypair` through
// the *same* wallet-adapter store, so the rest of the UI (Anchor provider,
// instruction panels, state view) stays wallet-agnostic.
//
// The secret key is generated once and persisted to `localStorage`, so the
// same dev wallet survives reloads (and can be funded once via `solana airdrop`
// against Surfpool). It is strictly a localnet/dev convenience: it is never
// appropriate for real funds, and it ships only in the client bundle.

import {
  BaseSignerWalletAdapter,
  WalletConnectionError,
  WalletReadyState,
} from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";
import {
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { TransactionVersion } from "@solana/web3.js";

export const LocalKeypairWalletName =
  "Local Keypair (dev)" as WalletName<"Local Keypair (dev)">;

const STORAGE_KEY = "stocksie.devWallet.secret.v1";

// 64-byte Ed25519 secret (32 seed + 32 public), stored as a JSON number array.
const SECRET_LEN = 64;

// Inline SVG kept URL-encoded to avoid pulling in a Buffer/base64 dependency.
const ICON_DATA_URI =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%23f59e0b'/%3E%3Ctext x='12' y='17' font-family='sans-serif' font-size='14' font-weight='bold' text-anchor='middle' fill='%23111'%3EK%3C/text%3E%3C/svg%3E";

function loadOrCreateKeypair(): Keypair {
  if (typeof window === "undefined") {
    throw new Error("LocalKeypairWalletAdapter is only usable in the browser.");
  }
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const bytes = Uint8Array.from(JSON.parse(stored) as number[]);
      if (bytes.length === SECRET_LEN) return Keypair.fromSecretKey(bytes);
    }
  } catch {
    // Corrupt storage — fall through and generate a fresh keypair.
  }
  const keypair = Keypair.generate();
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(Array.from(keypair.secretKey))
  );
  return keypair;
}

/**
 * A wallet-adapter backed by an in-browser `Keypair`. Implements the full
 * `SignerWalletAdapter` surface so it can sit alongside Wallet Standard
 * extension wallets in `WalletProvider`.
 */
export class LocalKeypairWalletAdapter extends BaseSignerWalletAdapter {
  readonly name = LocalKeypairWalletName;
  readonly url = "https://stocksie.local/dev-wallet";
  readonly icon = ICON_DATA_URI;
  readonly supportedTransactionVersions: ReadonlySet<TransactionVersion> =
    new Set<TransactionVersion>(["legacy", 0]);

  private _publicKey: PublicKey | null = null;
  private _connecting = false;
  private _keypair: Keypair | null = null;
  private readonly _readyState: WalletReadyState = WalletReadyState.Installed;

  get publicKey(): PublicKey | null {
    return this._publicKey;
  }

  get connecting(): boolean {
    return this._connecting;
  }

  get readyState(): WalletReadyState {
    return this._readyState;
  }

  async connect(): Promise<void> {
    if (this._publicKey) return;
    if (this._connecting) return;
    this._connecting = true;
    try {
      const keypair = loadOrCreateKeypair();
      this._keypair = keypair;
      this._publicKey = keypair.publicKey;
      this.emit("connect", keypair.publicKey);
    } catch (error) {
      // wallet-adapter's `error` event is typed `(error: WalletError) => void`,
      // so wrap the underlying failure in a concrete `WalletConnectionError`
      // (which carries the required `error` discriminant) before emitting.
      const cause = error instanceof Error ? error : new Error(String(error));
      const walletError = new WalletConnectionError(
        cause.message || "Failed to connect the local keypair wallet."
      );
      this.emit("error", walletError);
      throw walletError;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    // Keep the persisted secret so the same dev wallet reconnects; only clear
    // the in-memory copy so subsequent `signTransaction` calls fail loudly.
    this._keypair = null;
    this._publicKey = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T
  ): Promise<T> {
    const keypair = this.requireKeypair("signTransaction");
    if (transaction instanceof VersionedTransaction) {
      transaction.sign([keypair]);
    } else {
      transaction.sign(keypair);
    }
    return transaction;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> {
    const keypair = this.requireKeypair("signAllTransactions");
    for (const tx of transactions) {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.sign(keypair);
      }
    }
    return transactions;
  }

  private requireKeypair(operation: string): Keypair {
    const keypair = this._keypair;
    if (!keypair) {
      throw new Error(
        `LocalKeypairWalletAdapter.${operation}: wallet is not connected`
      );
    }
    return keypair;
  }
}
