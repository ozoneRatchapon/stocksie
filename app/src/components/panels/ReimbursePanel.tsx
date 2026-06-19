"use client";

// ReimbursePanel — pay out an approved, restocked purchase request.
//
// `reimburse_buyer` is the settlement step of the purchase lifecycle:
//
//   - Caller  : the household Owner or Parent (the approver who green-lit the
//     spend). Authorised via `caller_member.can_approve()`.
//   - Buyer   : the member who actually made the purchase and confirmed
//     restock. They receive the lamports. The on-chain `buyer` account must
//     match `request.buyer` (set immutably at creation).
//   - Request : must be in the `Restocked` state (only restocked requests can
//     be reimbursed — the program rejects any earlier state).
//   - Amount  : `lamports` ≤ `request.amount_lamports` (the spend ceiling
//     recorded at creation). The buyer may have spent less than the ceiling,
//     in which case the actual payout is the lower figure; it can never
//     exceed the ceiling. Hard circuit breaker: MAX_REIMBURSEMENT_LAMPORTS
//     (0.5 SOL).
//
// After reimbursement the request moves to `Reimbursed` (a terminal state),
// the buyer's `Member.reward_points` earns REWARD_FULL_RUN_COMPLETED, and the
// household vault is debited by exactly the reimbursed amount.

import { useMemo, useState } from "react";
import BN from "bn.js";
import { useProgram } from "@/lib/program";
import { useHouseholdContext } from "@/hooks/useHouseholdContext";
import { useTransactionWithRefresh as useTransaction } from "@/hooks/useRefresh";
import { memberPda, purchasePda } from "@/lib/accounts";
import { tryParsePublicKey, tryParseUint64 } from "@/lib/parse";
import { solToLamports } from "@/lib/format";
import { MAX_REIMBURSEMENT_LAMPORTS } from "@/lib/constants";
import { Panel, SubPanel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";
import { ConnectGate } from "@/components/ui/ConnectGate";

// Display ceiling for the amount field. The program enforces the real ceiling
// (MAX_REIMBURSEMENT_LAMPORTS = 0.5 SOL) on-chain; this constant just keeps
// the placeholder / max attribute in sync with that limit.
const MAX_REIMBURSE_SOL = "0.5";

export function ReimbursePanel() {
  return (
    <Panel
      title="Pay back"
      description="Pay a buyer back for something they bought on behalf of the household. Admin or approver only. The buyer must match the request's recorded buyer, and the amount can't exceed the request's spending limit (or the 0.5 SOL safety limit)."
    >
      <ConnectGate>
        <ReimburseForm />
      </ConnectGate>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// reimburse_buyer
// ---------------------------------------------------------------------------

function ReimburseForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const [requestIdInput, setRequestIdInput] = useState("");
  const [buyerInput, setBuyerInput] = useState("");
  const [amountInput, setAmountInput] = useState("");

  const requestId = useMemo(
    () => tryParseUint64(requestIdInput),
    [requestIdInput]
  );
  const buyerWallet = useMemo(
    () => tryParsePublicKey(buyerInput),
    [buyerInput]
  );
  const lamports = useMemo(() => solToLamports(amountInput), [amountInput]);

  const requestIdError = useMemo(() => {
    if (requestIdInput.trim().length === 0) return null;
    return requestId === null ? "Enter a non-negative integer" : null;
  }, [requestIdInput, requestId]);

  const buyerError = useMemo(() => {
    if (buyerInput.trim().length === 0) return null;
    return buyerWallet ? null : "Invalid Solana address";
  }, [buyerInput, buyerWallet]);

  const amountError = useMemo(() => {
    if (amountInput.trim().length === 0) return null;
    if (lamports === null) return "Enter a valid SOL amount (e.g. 0.05)";
    if (lamports <= 0n) return "Amount must be greater than zero";
    if (lamports > BigInt(MAX_REIMBURSEMENT_LAMPORTS)) {
      return `Exceeds the 0.5 SOL safety limit`;
    }
    return null;
  }, [amountInput, lamports]);

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!buyerWallet &&
    requestId !== null &&
    lamports !== null &&
    lamports > 0n &&
    lamports <= BigInt(MAX_REIMBURSEMENT_LAMPORTS) &&
    !requestIdError &&
    !buyerError &&
    !amountError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !buyerWallet ||
      requestId === null ||
      lamports === null
    ) {
      return;
    }
    const request = purchasePda(household, requestId);
    const buyerMember = memberPda(household, buyerWallet);
    void tx.submit(async () => {
      // reimburse_buyer(lamports): the caller (Owner/Parent) authorises the
      // payout; the buyer receives it. Account names exactly mirror the IDL:
      //   household, callerMember, request, buyerMember, buyer, caller
      // The buyer account is mut (receives lamports); the household vault is
      // debited by exactly `lamports`. The program rejects with
      // AmountExceedsMaximum if `lamports > request.amount_lamports`.
      return program.methods
        .reimburseBuyer(new BN(lamports.toString()))
        .accountsStrict({
          household,
          callerMember,
          request,
          buyerMember,
          buyer: buyerWallet,
          caller: connectedWallet,
        })
        .rpc();
    });
  };

  // Owner/Parent gate: the program rejects any non-Owner/Parent caller with
  // `UnauthorizedRole`. Surface a clear hint up-front (mirroring FundsPanel's
  // withdraw gate) rather than letting the user discover it via a failed
  // transaction. We use `isOwnerConnected` as a conservative proxy: the UI
  // cannot read the connected wallet's role without an extra account fetch.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="Pay back the buyer"
        hint="Admin or approver. Sign in as the household admin (or set the admin address above to your account) to pay buyers back."
      >
        <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
          You're not signed in as this household's admin. Pay-backs are
          admin-only in this reference UI; the on-chain gate also admits the
          Parent role.
        </p>
      </SubPanel>
    );
  }

  return (
    <SubPanel
      label="Pay back the buyer"
      hint="Admin or approver. Pays a buyer back for a bought request. The request must be marked as bought; the amount is bounded by the request's spending limit and the 0.5 SOL safety limit. The buyer earns 15 reward points on success."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_2fr_auto]">
        <Field
          label="Request #"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
          helpText="The id assigned at creation (visible in the live state view)."
        />
        <Field
          label="Buyer's address"
          value={buyerInput}
          onChange={setBuyerInput}
          placeholder="Their wallet address"
          mono
          error={buyerError}
          onSubmit={handleSubmit}
          helpText="Must match the buyer recorded on the request exactly."
        />
        <Field
          label="Amount"
          value={amountInput}
          onChange={setAmountInput}
          type="number"
          placeholder={MAX_REIMBURSE_SOL}
          suffix="SOL"
          min="0"
          max={MAX_REIMBURSE_SOL}
          step="0.0001"
          mono
          error={amountError}
          onSubmit={handleSubmit}
          helpText="What they actually spent — may be less than the request's spending limit, never more."
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
          >
            Pay back buyer
          </Button>
        </div>
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
