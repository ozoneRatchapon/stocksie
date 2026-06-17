"use client";

// FundsPanel — vault top-up and emergency drain.
//
// Two instructions, two sub-sections, one shared design:
//
//   - `deposit_funds` : any active member (Owner/Parent/Child/Guest) tops up
//     the household vault. The `depositorMember` PDA is seeded by the
//     connected wallet, so this works regardless of whether the connected
//     wallet is the household owner.
//   - `withdraw_funds`: Owner-only emergency drain. The connected wallet MUST
//     be the household owner (the program re-checks `household.owner ==
//     owner.key()` as defense-in-depth), so this sub-section is gated behind
//     `isOwnerConnected` and renders a hint otherwise.
//
// Both flows parse a SOL amount from the user, convert it to lamports via
// float-free bigint math (`solToLamports`), and submit through `useTransaction`
// so the pending / signature / error surface is uniform with every other panel.

import { useMemo, useState } from "react";
import BN from "bn.js";
import { useProgram } from "@/lib/program";
import { useHouseholdContext } from "@/hooks/useHouseholdContext";
import { useTransactionWithRefresh as useTransaction } from "@/hooks/useRefresh";
import { SYSTEM_PROGRAM_ID } from "@/lib/accounts";
import { solToLamports } from "@/lib/format";
import {
  MIN_REQUEST_LAMPORTS,
  MAX_REIMBURSEMENT_LAMPORTS,
} from "@/lib/constants";
import { Panel, SubPanel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";
import { ConnectGate } from "@/components/ui/ConnectGate";

// Soft client-side guardrails for the SOL inputs. The program enforces its own
// hard limits (`ZeroDeposit`, `AmountExceedsMaximum`, etc.); these constants
// just keep the form from encouraging obviously-wrong inputs.
const MIN_DEPOSIT_SOL = "0.0001"; // 100_000 lamports — matches MIN_REQUEST_LAMPORTS floor
const MAX_WITHDRAW_SOL_DISPLAY = "0.5"; // 500_000_000 lamports — matches MAX_REIMBURSEMENT_LAMPORTS

export function FundsPanel() {
  return (
    <Panel
      title="Funds"
      description="Top up the shared household vault, or — for the household owner — perform an emergency drain. Routine spending flows through the purchase approval + reimbursement pipeline, not through withdraw."
    >
      <ConnectGate>
        <DepositForm />
        <WithdrawForm />
      </ConnectGate>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// deposit_funds
// ---------------------------------------------------------------------------

function DepositForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember } = useHouseholdContext();
  const tx = useTransaction();
  const [amount, setAmount] = useState("");

  const parsed = useMemo(() => solToLamports(amount), [amount]);

  // Local validation: positive + parseable. Empty input is allowed (just
  // disables submit) so the user can clear the field without an error flash.
  const amountError = useMemo(() => {
    if (amount.trim().length === 0) return null;
    if (parsed === null) return "Enter a valid SOL amount (e.g. 0.5)";
    if (parsed <= 0n) return "Amount must be greater than zero";
    if (parsed < BigInt(MIN_REQUEST_LAMPORTS)) {
      return `Minimum deposit is ${MIN_DEPOSIT_SOL} SOL`;
    }
    return null;
  }, [amount, parsed]);

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    parsed !== null &&
    parsed > 0n &&
    !amountError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      parsed === null
    )
      return;
    void tx.submit(async () => {
      // BN accepts a base-10 string, which avoids any float round-trip from
      // the bigint lamport value. `.rpc()` returns the transaction signature
      // after confirmation under the provider's default commitment.
      return program.methods
        .depositFunds(new BN(parsed.toString()))
        .accountsStrict({
          household,
          depositorMember: callerMember,
          depositor: connectedWallet,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="deposit_funds"
      hint="Any active member may top up the vault. The deposit is attributed to your membership in the on-chain FundsDeposited event."
    >
      <Field
        label="Amount"
        value={amount}
        onChange={setAmount}
        type="number"
        placeholder={MIN_DEPOSIT_SOL}
        suffix="SOL"
        min={MIN_DEPOSIT_SOL}
        step="0.0001"
        mono
        error={amountError}
        onSubmit={handleSubmit}
        helpText="Parsed as lamports (1 SOL = 1,000,000,000 lamports) using float-free bigint math."
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
        >
          Deposit
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}

// ---------------------------------------------------------------------------
// withdraw_funds
// ---------------------------------------------------------------------------

function WithdrawForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const [amount, setAmount] = useState("");

  const parsed = useMemo(() => solToLamports(amount), [amount]);

  const amountError = useMemo(() => {
    if (amount.trim().length === 0) return null;
    if (parsed === null) return "Enter a valid SOL amount (e.g. 0.5)";
    if (parsed <= 0n) return "Amount must be greater than zero";
    if (parsed > BigInt(MAX_REIMBURSEMENT_LAMPORTS)) {
      return `Amount exceeds the display ceiling (${MAX_WITHDRAW_SOL_DISPLAY} SOL)`;
    }
    return null;
  }, [amount, parsed]);

  const canSubmit =
    isOwnerConnected &&
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    parsed !== null &&
    parsed > 0n &&
    !amountError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      parsed === null
    )
      return;
    void tx.submit(async () => {
      // withdraw_funds accounts: household, callerMember, owner, systemProgram.
      // The owner signer is both the authorizing wallet and the drain
      // destination — the program pins the destination to household.owner.
      return program.methods
        .withdrawFunds(new BN(parsed.toString()))
        .accountsStrict({
          household,
          callerMember,
          owner: connectedWallet,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc();
    });
  };

  // Owner-only gate: the program rejects any non-owner caller with
  // `UnauthorizedRole` / `NotOwner`, so render a clear hint up-front rather
  // than letting the user discover it via a failed transaction.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="withdraw_funds"
        hint="Emergency drain — owner only. Connect the household owner wallet (or set the owner field above to your wallet) to enable withdrawals."
      >
        <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-3 text-xs text-slate-400">
          The connected wallet is not the resolved household owner. Withdrawals
          are restricted to the owner and always drain back to that same wallet.
        </p>
      </SubPanel>
    );
  }

  return (
    <SubPanel
      label="withdraw_funds"
      hint="Owner-only emergency drain. Funds always return to the household owner wallet — routine spending must go through reimburse_buyer against an approved purchase request."
    >
      <Field
        label="Amount"
        value={amount}
        onChange={setAmount}
        type="number"
        placeholder={MAX_WITHDRAW_SOL_DISPLAY}
        suffix="SOL"
        min="0"
        step="0.0001"
        mono
        error={amountError}
        onSubmit={handleSubmit}
        helpText="The vault must hold at least this many lamports; the program debits via a direct PDA → owner lamport move."
      />
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
          variant="danger"
        >
          Withdraw
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}
