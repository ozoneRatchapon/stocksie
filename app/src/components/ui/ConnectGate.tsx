// ConnectGate — a wrapper that hides panel bodies until their prerequisites
// (a connected wallet, and — for non-init panels — a resolved household) are
// met, rendering a short, actionable hint instead.
//
// Used by every instruction panel so they never have to thread `if (!wallet)`
// / `if (!household)` guards through their form JSX. The `initialize_household`
// panel is the one case that needs ONLY a wallet (it creates the household),
// so it renders the gate with `requireHousehold={false}`.

import { WalletButton } from '@/components/WalletButton';
import { useHouseholdContext } from '@/hooks/useHouseholdContext';
import type { ReactNode } from 'react';

export type ConnectGateProps = {
  /**
   * Whether the gate should require a resolved household PDA in addition to a
   * connected wallet. Defaults to `true` — every panel except
   * `initialize_household` needs a household address to resolve its other PDAs.
   */
  requireHousehold?: boolean;
  /** Panel body, rendered once prerequisites are met. */
  children: ReactNode;
};

/**
 * Render `children` only when prerequisites are met; otherwise render a hint.
 *
 * Two ordered checks, in increasing severity:
 *   1. Wallet connected? If not → "connect a wallet" hint + the
 *      `<WalletButton />` (which doubles as the disconnect control once
 *      connected).
 *   2. Household resolved? If not (and `requireHousehold`) → "enter the
 *      household owner" hint pointing at the page-level owner field.
 */
export function ConnectGate({ requireHousehold = true, children }: ConnectGateProps) {
  const { isConnected, household } = useHouseholdContext();

  if (!isConnected) {
    return (
      <GateShell>
        <p className="text-sm text-slate-300">
          Sign in to use this.
        </p>
        <p className="text-xs text-slate-500">
          Sign in with Phantom, Solflare, or Backpack — or use the built-in
          dev account to try Stocksie on the local cluster.
        </p>
        <WalletButton />
      </GateShell>
    );
  }

  if (requireHousehold && !household) {
    return (
      <GateShell>
        <p className="text-sm text-slate-300">
          Enter the household admin's address above to load your household.
        </p>
        <p className="text-xs text-slate-500">
          Your household is tied to its admin's address. It defaults to your
          own account; change it if you joined a household someone else set up.
        </p>
      </GateShell>
    );
  }

  return <>{children}</>;
}

/** Shared visual wrapper for both gate states — a muted, dashed-bordered box. */
function GateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-slate-700 bg-slate-950/30 p-5">
      {children}
    </div>
  );
}
