'use client';

// Household-resolution context — the single piece of shared state every Stocksie
// panel reads.
//
// ## Why this exists (the owner-vs-caller distinction)
//
// The household PDA is seeded by the household **owner** — `["household",
// owner]` — and the owner is fixed at `initialize_household` time. Every later
// instruction (`add_member`, `deposit_funds`, `create_purchase_request`, …)
// can be called by *any* active member of that household, not just the owner.
//
// That means a panel cannot derive the household from the connected wallet
// alone: when a non-owner member connects, `findHouseholdPda(theirWallet)`
// would produce the wrong PDA. Instead the household is resolved from an
// explicit **owner pubkey** — the seed basis — which defaults to the connected
// wallet (the owner-driven happy path: "I created this household, I'm driving
// the UI") but can be overridden to point at any other owner (the
// member-driven path: "I'm the Child, I want to transact against my parent's
// household").
//
// ## What the context provides
//
//   - `ownerInput` / `setOwnerInput` — the raw text-field value (the source of
//     truth), plus a derived validation error.
//   - `ownerForHousehold` — the parsed `PublicKey` (or null when the input is
//     empty / invalid).
//   - `household` — the resolved household PDA (`householdPda(owner)`), or null.
//   - `connectedWallet` / `isConnected` — the active wallet, mirrored from
//     `useWallet()` so panels have a single hook to read both.
//   - `callerMember` — the connected wallet's `Member` PDA in this household
//     (`memberPda(household, connectedWallet)`). Null when either input is
//     missing; provided here because ~10 of 14 instructions need it.
//   - `isOwnerConnected` — convenience flag for "the connected wallet IS the
//     resolved owner" (the happy path).
//   - `isOverridden` / `resetToConnectedWallet` — override management so a
//     wallet connect/disconnect doesn't clobber a user's manual edit until
//     they explicitly ask for it.
//
// ## Override semantics
//
// A manual `setOwnerInput` call marks the field as overridden; subsequent
// wallet connect/disconnect events leave the input untouched. The user can
// always return to the default behavior with `resetToConnectedWallet()`. On a
// fresh page load (ref resets), the field auto-fills from whichever wallet
// auto-connects.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet } from '@solana/wallet-adapter-react';
import { callerAccounts, householdPda, memberPda } from '@/lib/accounts';

/** Parse a base58 string into a `PublicKey`, returning `null` on failure. */
function tryParsePublicKey(input: string): PublicKey | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  try {
    return new PublicKey(trimmed);
  } catch {
    return null;
  }
}

export type HouseholdContextValue = {
  /** Raw text-field value for the household owner address. Source of truth. */
  ownerInput: string;
  /** Update the owner input. Any call marks the field as user-overridden so
   *  subsequent wallet changes don't clobber it. */
  setOwnerInput: (value: string) => void;
  /** Validation error for the current `ownerInput`, or null when valid/empty. */
  ownerInputError: string | null;
  /** The parsed owner `PublicKey`, or null when the input is empty/invalid. */
  ownerForHousehold: PublicKey | null;
  /** The resolved household PDA (`["household", owner]`), or null. This single
   *  address is both the program-state anchor and the SOL vault. */
  household: PublicKey | null;
  /** The connected wallet's `PublicKey`, or null. Mirrors `useWallet().publicKey`. */
  connectedWallet: PublicKey | null;
  /** Whether any wallet is currently connected. */
  isConnected: boolean;
  /** The connected wallet's `Member` PDA in this household
   *  (`["member", household, connectedWallet]`), or null when either input is
   *  missing. ~10 of 14 instructions take this as the `callerMember` account. */
  callerMember: PublicKey | null;
  /** Convenience: the standard `{ household, callerMember, caller,
   *  systemProgram }` bundle for instructions whose caller is the connected
   *  wallet. Null when `household` or `connectedWallet` is missing. */
  callerBundle: {
    household: PublicKey;
    callerMember: PublicKey;
    caller: PublicKey;
    systemProgram: PublicKey;
  } | null;
  /** True when the resolved owner equals the connected wallet (the happy path). */
  isOwnerConnected: boolean;
  /** True when the user has manually edited the owner input (so wallet
   *  changes are being intentionally ignored). */
  isOverridden: boolean;
  /** Reset the owner input back to the connected wallet (clears the override
   *  flag). No-op when no wallet is connected. */
  resetToConnectedWallet: () => void;
};

const HouseholdContext = createContext<HouseholdContextValue | null>(null);

/**
 * Provider for {@link useHouseholdContext}.
 *
 * Wrap the panel tree (typically inside `Providers`, after the wallet
 * providers) so every panel and the `StateView` read the same household
 * resolution. State is held here — not in `page.tsx` — so the panels stay
 * decoupled from the page shell.
 */
export function HouseholdContextProvider({ children }: { children: ReactNode }) {
  const { publicKey, connected } = useWallet();

  // Source of truth: the raw owner-address text. Defaults to empty; the
  // wallet-sync effect below populates it from the connected wallet.
  const [ownerInput, setOwnerInputState] = useState<string>('');
  // Tracks whether the user has manually edited the field. A ref (not state)
  // because the wallet-sync effect reads it without needing it as a dep —
  // overriding is a one-way latch until `resetToConnectedWallet` clears it.
  const overriddenRef = useRef(false);
  const [isOverridden, setIsOverridden] = useState(false);

  // Wallet sync: whenever the connected wallet changes AND the user hasn't
  // overridden the field, auto-populate it with the wallet's base58. On
  // disconnect (publicKey → null) the field is cleared too, unless overridden.
  useEffect(() => {
    if (overriddenRef.current) return;
    setOwnerInputState(publicKey ? publicKey.toBase58() : '');
  }, [publicKey]);

  // Wrap setOwnerInput so any manual edit flips the override latch. This is
  // what lets a member connect their wallet and then paste the owner's
  // address without the next reconnect overwriting it.
  const setOwnerInput = useCallback((value: string) => {
    overriddenRef.current = true;
    setIsOverridden(true);
    setOwnerInputState(value);
  }, []);

  const resetToConnectedWallet = useCallback(() => {
    overriddenRef.current = false;
    setIsOverridden(false);
    setOwnerInputState(publicKey ? publicKey.toBase58() : '');
  }, [publicKey]);

  // Derive the parsed owner + validation error in one memoized pass. An empty
  // input is valid (just yields a null owner); a non-empty but unparseable
  // string is an error.
  const { ownerForHousehold, ownerInputError } = useMemo<{
    ownerForHousehold: PublicKey | null;
    ownerInputError: string | null;
  }>(() => {
    const trimmed = ownerInput.trim();
    if (trimmed.length === 0) return { ownerForHousehold: null, ownerInputError: null };
    const parsed = tryParsePublicKey(trimmed);
    if (parsed) return { ownerForHousehold: parsed, ownerInputError: null };
    return { ownerForHousehold: null, ownerInputError: 'Invalid Solana address' };
  }, [ownerInput]);

  // Derive the household PDA + the connected wallet's member PDA. Both are
  // null when their inputs are missing so panels can short-circuit with a
  // "connect wallet / enter owner" guard rather than handling thrown errors.
  const household = useMemo(
    () => (ownerForHousehold ? householdPda(ownerForHousehold) : null),
    [ownerForHousehold],
  );

  const callerMember = useMemo(
    () => (household && publicKey ? memberPda(household, publicKey) : null),
    [household, publicKey],
  );

  const callerBundle = useMemo(() => {
    if (!household || !publicKey || !callerMember) return null;
    return callerAccounts(ownerForHousehold!, publicKey);
  }, [household, publicKey, callerMember, ownerForHousehold]);

  const isOwnerConnected = useMemo(() => {
    if (!ownerForHousehold || !publicKey) return false;
    return ownerForHousehold.equals(publicKey);
  }, [ownerForHousehold, publicKey]);

  const value = useMemo<HouseholdContextValue>(
    () => ({
      ownerInput,
      setOwnerInput,
      ownerInputError,
      ownerForHousehold,
      household,
      connectedWallet: publicKey,
      isConnected: connected,
      callerMember,
      callerBundle,
      isOwnerConnected,
      isOverridden,
      resetToConnectedWallet,
    }),
    [
      ownerInput,
      setOwnerInput,
      ownerInputError,
      ownerForHousehold,
      household,
      publicKey,
      connected,
      callerMember,
      callerBundle,
      isOwnerConnected,
      isOverridden,
      resetToConnectedWallet,
    ],
  );

  return <HouseholdContext.Provider value={value}>{children}</HouseholdContext.Provider>;
}

/**
 * Read the household-resolution context.
 *
 * Throws (with a helpful message) when called outside
 * {@link HouseholdContextProvider} — this catches provider-wiring mistakes at
 * first render rather than failing later with a confusing `null`-dereference.
 */
export function useHouseholdContext(): HouseholdContextValue {
  const ctx = useContext(HouseholdContext);
  if (!ctx) {
    throw new Error(
      'useHouseholdContext must be used inside a <HouseholdContextProvider>.',
    );
  }
  return ctx;
}
