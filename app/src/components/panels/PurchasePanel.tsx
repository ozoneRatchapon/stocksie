"use client";

// PurchasePanel — the full purchase-request lifecycle.
//
// Five instructions covering the household shopping pipeline:
//
//   - `create_purchase_request` : any active Owner/Parent/Child (not Guest)
//     opens a request as the low-stock reporter. Seeds the new request PDA at
//     `request_counter + 1`, range-checks the amount, and rewards the reporter
//     with REWARD_LOW_STOCK_REPORT. The buyer is named as an instruction arg
//     and must be an active member of the same household.
//   - `approve_purchase_request` : Owner/Parent approves a pending request.
//   - `reject_purchase_request`  : Owner/Parent rejects a pending request.
//     Takes a blake3 `reason_hash` (the off-chain reason text never lands
//     on-chain).
//   - `confirm_restock`          : the BUYER confirms they restocked. Takes a
//     `unit_cost_hash` (may differ from the create snapshot if the buyer
//     picked a different package — used off-chain for cost-saving scoring).
//     Rewards the buyer with REWARD_RESTOCK_COMPLETED.
//   - `close_purchase_request`   : Owner/Parent closes a request in a terminal
//     state (reimbursed / rejected) and reclaims rent.
//
// All four post-create instructions take an existing `requestId` (a u64) and
// derive the request PDA from `[PURCHASE_SEED, household, id_le_bytes]`.
// `create` is the exception: it must read the household's current
// `requestCounter` to derive the PDA for the new request at `counter + 1`.

import { useMemo, useState } from "react";
import BN from "bn.js";
import type { PublicKey } from "@solana/web3.js";
import { useProgram } from "@/lib/program";
import { useHouseholdContext } from "@/hooks/useHouseholdContext";
import { useTransactionWithRefresh as useTransaction } from "@/hooks/useRefresh";
import { SYSTEM_PROGRAM_ID, memberPda, purchasePda } from "@/lib/accounts";
import { toHash32 } from "@/lib/hashes";
import { tryParsePublicKey, tryParseUint64 } from "@/lib/parse";
import { solToLamports } from "@/lib/format";
import {
  MIN_REQUEST_LAMPORTS,
  MAX_REIMBURSEMENT_LAMPORTS,
  REWARD_COST_SAVING,
} from "@/lib/constants";
import { Panel, SubPanel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";
import { ConnectGate } from "@/components/ui/ConnectGate";
import {
  BestValueModal,
  type BestValueChoice,
} from "@/components/BestValueModal";
import {
  clearSnapshot,
  getSnapshot,
  setActual,
  setBenchmark,
  type SnapshotSide,
} from "@/lib/pendingSnapshots";
import { computeCostSaving, costSavingReasonText } from "@/lib/costSaving";

export function PurchasePanel() {
  return (
    <Panel
      title="Shopping"
      description="Report something the household needs, then approve it, decline it, mark it as bought, pay the buyer back, or close it. The full lifecycle (waiting → approved → bought → paid back, or declined) runs through these five actions."
    >
      <ConnectGate>
        <CreateForm />
        <ApproveForm />
        <RejectForm />
        <ConfirmRestockForm />
        <CostSavingRewardForm />
        <CloseForm />
      </ConnectGate>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// create_purchase_request
// ---------------------------------------------------------------------------

function CreateForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember } = useHouseholdContext();
  const tx = useTransaction();
  const [amountInput, setAmountInput] = useState("");
  const [itemInput, setItemInput] = useState("");
  const [unitCostInput, setUnitCostInput] = useState("");
  const [buyerInput, setBuyerInput] = useState("");
  // Best-value compare modal (plan 006 D.2). When the user picks an offer, its
  // text back-fills `unitCostInput` (hashed on-chain unchanged) and its
  // structured per-unit data is stashed here so it can be persisted against
  // the new request id once the create tx confirms (D.3).
  const [compareOpen, setCompareOpen] = useState(false);
  const [benchmarkSide, setBenchmarkSide] = useState<SnapshotSide | null>(null);

  const amountLamports = useMemo(
    () => solToLamports(amountInput),
    [amountInput]
  );
  const buyerWallet = useMemo(
    () => tryParsePublicKey(buyerInput),
    [buyerInput]
  );

  const amountError = useMemo(() => {
    if (amountInput.trim().length === 0) return null;
    if (amountLamports === null) return "Enter a valid SOL amount (e.g. 0.05)";
    if (amountLamports < BigInt(MIN_REQUEST_LAMPORTS)) {
      return `Minimum is 0.0001 SOL (${MIN_REQUEST_LAMPORTS.toString()} lamports)`;
    }
    if (amountLamports > BigInt(MAX_REIMBURSEMENT_LAMPORTS)) {
      return `Exceeds 0.5 SOL reimbursement ceiling (${MAX_REIMBURSEMENT_LAMPORTS.toString()} lamports)`;
    }
    return null;
  }, [amountInput, amountLamports]);

  const buyerError = useMemo(() => {
    if (buyerInput.trim().length === 0) return null;
    return buyerWallet ? null : "Invalid Solana address";
  }, [buyerInput, buyerWallet]);

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!buyerWallet &&
    amountLamports !== null &&
    amountLamports >= BigInt(MIN_REQUEST_LAMPORTS) &&
    amountLamports <= BigInt(MAX_REIMBURSEMENT_LAMPORTS) &&
    itemInput.trim().length > 0 &&
    unitCostInput.trim().length > 0 &&
    !amountError &&
    !buyerError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !buyerWallet ||
      amountLamports === null ||
      itemInput.trim().length === 0 ||
      unitCostInput.trim().length === 0
    ) {
      return;
    }
    const buyerMember = memberPda(household, buyerWallet);
    const itemHash = toHash32(itemInput);
    const unitCostHash = toHash32(unitCostInput);
    // Capture the benchmark snapshot chosen via the compare modal so it can be
    // persisted against the new request id AFTER the create confirms (the id
    // is only known then). A local copy avoids the closure going stale if the
    // user opens the compare modal again mid-submit.
    const benchmark = benchmarkSide;
    void tx.submit(async () => {
      // The request PDA uses `request_counter + 1` — the *next* id, which the
      // handler commits via Household::next_request_id. Reading the household
      // here (rather than trusting a cached counter) closes the race window
      // where a concurrent request could have bumped the counter.
      const householdAccount = await program.account.household.fetch(household);
      const nextId = BigInt(householdAccount.requestCounter.toString(10)) + 1n;
      const request = purchasePda(household, nextId);
      const signature = await program.methods
        .createPurchaseRequest(
          new BN(amountLamports.toString()),
          itemHash,
          unitCostHash,
          buyerWallet
        )
        .accountsStrict({
          household,
          callerMember,
          request,
          buyerMember,
          caller: connectedWallet,
          systemProgram: SYSTEM_PROGRAM_ID,
        })
        .rpc();
      // After the request is created, persist the benchmark offer's cleartext
      // per-unit data keyed by the new request id, so Phase E can score a
      // cost-saving once the buyer restocks. No-op if the snapshot was typed
      // freehand (no compare) — graceful, the auto-reward just won't fire.
      if (benchmark) setBenchmark(nextId, benchmark);
      return signature;
    });
  };

  return (
    <SubPanel
      label="Report something we need"
      hint="Open a request when you notice something's running low. You earn 10 reward points for reporting. The buyer must already be a member of this household. The item and price details are kept private."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Spending limit"
          value={amountInput}
          onChange={setAmountInput}
          type="number"
          placeholder="0.05"
          suffix="SOL"
          min="0.0001"
          max="0.5"
          step="0.0001"
          mono
          error={amountError}
          onSubmit={handleSubmit}
        />
        <Field
          label="Buyer's address"
          value={buyerInput}
          onChange={setBuyerInput}
          placeholder="Their wallet address"
          mono
          error={buyerError}
          onSubmit={handleSubmit}
          helpText="The member who will buy the item and mark it as bought."
        />
        <Field
          label="Item / quantity"
          value={itemInput}
          onChange={setItemInput}
          placeholder='e.g. "Pampers Size 3, 2 boxes"'
          helpText="🔒 Private — only a scrambled fingerprint is recorded."
          onSubmit={handleSubmit}
        />
        <Field
          label="Best-value snapshot"
          value={unitCostInput}
          onChange={(v) => {
            setUnitCostInput(v);
            // Manual edit after a compare choice: the structured benchmark no
            // longer matches the text, so drop it (the scoring will simply not
            // fire for this request — graceful).
            if (benchmarkSide) setBenchmarkSide(null);
          }}
          placeholder='e.g. "Lowest unit price at store X"'
          helpText="🔒 Private — used later to score cost-savings."
          onSubmit={handleSubmit}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
          >
            Open request
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCompareOpen(true)}
          >
            <span aria-hidden="true">⚖</span>
            Compare prices
          </Button>
        </div>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
      <BestValueModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        onChoose={(choice: BestValueChoice) => {
          setUnitCostInput(choice.text);
          setBenchmarkSide({
            priceLamports: choice.priceLamports,
            perUnitLamports: choice.perUnitLamports,
            label: choice.label,
            packUnits: choice.packUnits,
            unitGrams: choice.unitGrams,
          });
          setCompareOpen(false);
        }}
      />
    </SubPanel>
  );
}

// ---------------------------------------------------------------------------
// Shared helper for the four post-create instructions (approve/reject/confirm/close)
// ---------------------------------------------------------------------------

/**
 * Build the common `{ household, callerMember, request, caller }` account set
 * for the post-create purchase instructions. `request` is derived from the
 * user-provided `requestId`. Returns `null` when any prerequisite is missing.
 *
 * Note: the account-name for the caller's Member PDA is `callerMember` for
 * approve/reject/close, but `buyerMember` for confirm_restock (because the
 * buyer, not the caller, is the actor). confirm_restock therefore does NOT use
 * this helper.
 */
function buildRequestAccounts(
  household: PublicKey,
  caller: PublicKey,
  requestId: bigint
): {
  household: PublicKey;
  callerMember: PublicKey;
  request: PublicKey;
  caller: PublicKey;
} | null {
  return {
    household,
    callerMember: memberPda(household, caller),
    request: purchasePda(household, requestId),
    caller,
  };
}

/** Reusable request-id field with validation. */
function useRequestIdInput() {
  const [requestIdInput, setRequestIdInput] = useState("");
  const requestId = useMemo(
    () => tryParseUint64(requestIdInput),
    [requestIdInput]
  );
  const requestIdError = useMemo(() => {
    if (requestIdInput.trim().length === 0) return null;
    return requestId === null ? "Enter a non-negative integer" : null;
  }, [requestIdInput, requestId]);
  return { requestIdInput, setRequestIdInput, requestId, requestIdError };
}

// ---------------------------------------------------------------------------
// approve_purchase_request
// ---------------------------------------------------------------------------

function ApproveForm() {
  const program = useProgram();
  const { household, connectedWallet, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const { requestIdInput, setRequestIdInput, requestId, requestIdError } =
    useRequestIdInput();

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    requestId !== null &&
    !requestIdError &&
    !tx.pending;

  const handleSubmit = () => {
    if (!program || !household || !connectedWallet || requestId === null)
      return;
    const accounts = buildRequestAccounts(
      household,
      connectedWallet,
      requestId
    );
    if (!accounts) return;
    void tx.submit(async () => {
      return program.methods
        .approvePurchaseRequest()
        .accountsStrict(accounts)
        .rpc();
    });
  };

  // Owner/Parent gate: the program rejects any non-Owner/Parent caller
  // with `UnauthorizedRole`. Surface a clear hint up-front (mirroring
  // FundsPanel's withdraw gate and RewardsPanel's award gate) rather than
  // letting the user discover it via a failed transaction.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="Approve the request"
        hint="Admin or approver. Sign in as the household admin (or set the admin address above to your account) to approve requests."
      >
        <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
          You're not signed in as this household's admin. Approvals are
          admin-only in this reference UI; the on-chain gate also admits the
          Parent role.
        </p>
      </SubPanel>
    );
  }

  return (
    <SubPanel
      label="Approve the request"
      hint="Admin or approver. Marks a waiting request as approved and records who approved it."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field
          label="Request #"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
          >
            Approve
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

// ---------------------------------------------------------------------------
// reject_purchase_request
// ---------------------------------------------------------------------------

function RejectForm() {
  const program = useProgram();
  const { household, connectedWallet, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const { requestIdInput, setRequestIdInput, requestId, requestIdError } =
    useRequestIdInput();
  const [reasonInput, setReasonInput] = useState("");

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    requestId !== null &&
    !requestIdError &&
    reasonInput.trim().length > 0 &&
    !tx.pending;

  const handleSubmit = () => {
    if (!program || !household || !connectedWallet || requestId === null)
      return;
    if (reasonInput.trim().length === 0) return;
    const accounts = buildRequestAccounts(
      household,
      connectedWallet,
      requestId
    );
    if (!accounts) return;
    const reasonHash = toHash32(reasonInput);
    void tx.submit(async () => {
      return program.methods
        .rejectPurchaseRequest(reasonHash)
        .accountsStrict(accounts)
        .rpc();
    });
  };

  // Owner/Parent gate: the program rejects any non-Owner/Parent caller
  // with `UnauthorizedRole`. Surface a clear hint up-front (mirroring
  // FundsPanel's withdraw gate and RewardsPanel's award gate) rather than
  // letting the user discover it via a failed transaction.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="Decline the request"
        hint="Admin or approver. Sign in as the household admin (or set the admin address above to your account) to decline requests."
      >
        <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
          You're not signed in as this household's admin. Declines are
          admin-only in this reference UI; the on-chain gate also admits the
          Parent role.
        </p>
      </SubPanel>
    );
  }

  return (
    <SubPanel
      label="Decline the request"
      hint="Admin or approver. Moves a waiting request to declined. The reason is kept private — only a scrambled fingerprint is recorded."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <Field
          label="Request #"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
        />
        <Field
          label="Reason"
          value={reasonInput}
          onChange={setReasonInput}
          placeholder='e.g. "Already have enough at home"'
          helpText="🔒 Private — only a scrambled fingerprint is recorded."
          onSubmit={handleSubmit}
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
            variant="danger"
          >
            Decline
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

// ---------------------------------------------------------------------------
// confirm_restock
// ---------------------------------------------------------------------------

function ConfirmRestockForm() {
  const program = useProgram();
  const { household } = useHouseholdContext();
  const tx = useTransaction();
  const { requestIdInput, setRequestIdInput, requestId, requestIdError } =
    useRequestIdInput();
  const [buyerInput, setBuyerInput] = useState("");
  const [unitCostInput, setUnitCostInput] = useState("");
  // Best-value compare modal (plan 006 D.2/D.3 — the restock side). The chosen
  // offer's actual per-unit data is persisted against `requestId` after the
  // restock confirms, so Phase E can score it against the create-time
  // benchmark. `requestId` is known up-front here (the user types it).
  const [compareOpen, setCompareOpen] = useState(false);
  const [actualSide, setActualSide] = useState<SnapshotSide | null>(null);

  const buyerWallet = useMemo(
    () => tryParsePublicKey(buyerInput),
    [buyerInput]
  );
  const buyerError = useMemo(() => {
    if (buyerInput.trim().length === 0) return null;
    return buyerWallet ? null : "Invalid Solana address";
  }, [buyerInput, buyerWallet]);

  const canSubmit =
    !!program &&
    !!household &&
    !!buyerWallet &&
    requestId !== null &&
    !requestIdError &&
    !buyerError &&
    unitCostInput.trim().length > 0 &&
    !tx.pending;

  const handleSubmit = () => {
    if (!program || !household || !buyerWallet || requestId === null) return;
    if (unitCostInput.trim().length === 0) return;
    const buyerMember = memberPda(household, buyerWallet);
    const request = purchasePda(household, requestId);
    const unitCostHash = toHash32(unitCostInput);
    // Capture the actual snapshot chosen via the compare modal so it can be
    // persisted against this request id once the restock confirms.
    const actual = actualSide;
    void tx.submit(async () => {
      // confirm_restock is called BY the buyer. Account names: household,
      // buyerMember, request, buyer. The buyer (not "caller") is the signer.
      const signature = await program.methods
        .confirmRestock(unitCostHash)
        .accountsStrict({
          household,
          buyerMember,
          request,
          buyer: buyerWallet,
        })
        .rpc();
      // Persist the actual offer's cleartext per-unit data keyed by this
      // request id, so Phase E can score `actual vs benchmark`. No-op if the
      // snapshot was typed freehand (no compare) — graceful.
      if (actual) setActual(requestId, actual);
      return signature;
    });
  };

  return (
    <SubPanel
      label="Mark as bought"
      hint="The buyer confirms they've bought the item. Earns 25 reward points. The price snapshot may differ from the original one — record what the buyer actually picked up."
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
        />
        <Field
          label="Buyer's address"
          value={buyerInput}
          onChange={setBuyerInput}
          placeholder="Their wallet address"
          mono
          error={buyerError}
          onSubmit={handleSubmit}
          helpText="Only the buyer can mark a request as bought."
        />
        <Field
          label="Actual unit cost"
          value={unitCostInput}
          onChange={(v) => {
            setUnitCostInput(v);
            // Manual edit after a compare choice: the structured actual no
            // longer matches the text, so drop it (scoring simply won't fire).
            if (actualSide) setActualSide(null);
          }}
          placeholder='e.g. "Cheapest pack at store Y"'
          helpText="🔒 Private — only a scrambled fingerprint is recorded."
          onSubmit={handleSubmit}
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
          >
            Mark as bought
          </Button>
        </div>
      </div>
      <div className="flex items-center">
        <Button variant="ghost" size="sm" onClick={() => setCompareOpen(true)}>
          <span aria-hidden="true">⚖</span>
          Compare prices
        </Button>
      </div>
      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
      <BestValueModal
        open={compareOpen}
        onClose={() => setCompareOpen(false)}
        onChoose={(choice: BestValueChoice) => {
          setUnitCostInput(choice.text);
          setActualSide({
            priceLamports: choice.priceLamports,
            perUnitLamports: choice.perUnitLamports,
            label: choice.label,
            packUnits: choice.packUnits,
            unitGrams: choice.unitGrams,
          });
          setCompareOpen(false);
        }}
      />
    </SubPanel>
  );
}

// ---------------------------------------------------------------------------
// cost-saving reward (Owner/Parent; fires the existing `award_reward`)
// ---------------------------------------------------------------------------

// CostSavingRewardForm — the payoff of the best-value feature (plan 006, Phase E).
//
// The on-chain program can't tell whether the buyer beat the "best-value
// snapshot" they were benchmarked against — it only stores a blake3 hash. So an
// Owner/Parent (whoever is online and authorized to grant rewards) reads the
// client-side cleartext snapshot for a request, and if the buyer paid less per
// unit than the benchmark, fires the EXISTING `award_reward` instruction for
// REWARD_COST_SAVING (50 pts). No Rust change is needed.
//
// This is the Owner/Parent-gated path (Q3): the buyer cannot self-trigger the
// reward because `award_reward` requires the Owner/Parent role. In the
// reference UI's happy path (single-browser localnet, one person playing the
// roles), the in-memory snapshot has both sides after create + restock, so the
// saving is detected here. On a different browser, or after a reload, the
// snapshot is gone — the form says so and points at the manual award in
// Rewards. That graceful degradation is the documented Q4 limitation.
function CostSavingRewardForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const [requestIdInput, setRequestIdInput] = useState("");
  const [buyerInput, setBuyerInput] = useState("");
  // The request id most recently awarded in this session. Set on success so the
  // hint can show a confirmation instead of the (now-cleared) snapshot's
  // "no comparison data" state. Cleared when the user moves to a different request.
  const [awardedId, setAwardedId] = useState<bigint | null>(null);

  const requestId = useMemo(
    () => tryParseUint64(requestIdInput),
    [requestIdInput]
  );
  const requestIdError = useMemo(() => {
    if (requestIdInput.trim().length === 0) return null;
    return requestId === null ? "Enter a non-negative integer" : null;
  }, [requestIdInput, requestId]);

  const buyerWallet = useMemo(
    () => tryParsePublicKey(buyerInput),
    [buyerInput]
  );
  const buyerError = useMemo(() => {
    if (buyerInput.trim().length === 0) return null;
    return buyerWallet ? null : "Invalid Solana address";
  }, [buyerInput, buyerWallet]);

  // Read the client-side snapshot (if any) for this request and score it. This
  // is the off-chain comparison the chain can't do. `null` means either side is
  // missing (freehand entry, different browser, or reload) → nothing to score.
  const saving = useMemo(() => {
    if (requestId === null) return null;
    const snapshot = getSnapshot(requestId);
    if (!snapshot) return null;
    return computeCostSaving(snapshot);
  }, [requestId, tx.nonce]);

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!buyerWallet &&
    requestId !== null &&
    saving !== null &&
    saving.isSaving &&
    !requestIdError &&
    !buyerError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !buyerWallet ||
      requestId === null ||
      !saving ||
      !saving.isSaving
    ) {
      return;
    }
    const targetMember = memberPda(household, buyerWallet);
    const reasonHash = toHash32(
      costSavingReasonText(requestId, saving.savingPerUnitLamports)
    );
    // Capture the id so we can clear the snapshot after success (prevents a
    // double-award for the same saving).
    const awardedRequestId = requestId;
    void tx.submit(async () => {
      // award_reward(member_wallet, points, reason_hash): the buyer receives
      // REWARD_COST_SAVING pts for beating the benchmark. The caller (this
      // Owner/Parent) authorizes it. Account shape mirrors AwardRewardForm.
      const signature = await program.methods
        .awardReward(
          buyerWallet,
          new BN(REWARD_COST_SAVING.toString()),
          reasonHash
        )
        .accountsStrict({
          household,
          callerMember,
          targetMember,
          caller: connectedWallet,
        })
        .rpc();
      // Drop the client-side snapshot so the same saving can't be rewarded
      // twice. The on-chain record (signature + reason hash) is the audit trail.
      clearSnapshot(awardedRequestId);
      setAwardedId(awardedRequestId);
      return signature;
    });
  };

  // Owner/Parent gate — same conservative proxy + UX guard as AwardRewardForm.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="Award a cost-saving reward"
        hint="Admin or approver. When a buyer beats the best-value snapshot, the admin (or an approver) awards them 50 reward points. Sign in as the household admin (or set the admin address above to your account) to do this."
      >
        <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
          You're not signed in as this household's admin. Cost-saving rewards
          are admin-only in this reference UI; the on-chain gate also admits the
          Parent role.
        </p>
      </SubPanel>
    );
  }

  return (
    <SubPanel
      label="Award a cost-saving reward"
      hint="Admin or approver. If a buyer bought the item cheaper per unit than the best-value snapshot they were benchmarked against, award them 50 reward points for the smart buy. The comparison runs off-chain — only a scrambled fingerprint of the reason is recorded."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <Field
          label="Request #"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
          helpText="The request the buyer restocked."
        />
        <Field
          label="Buyer's address"
          value={buyerInput}
          onChange={setBuyerInput}
          placeholder="Their wallet address"
          mono
          error={buyerError}
          onSubmit={handleSubmit}
          helpText="The member who bought it — they receive the points."
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
          >
            Award {REWARD_COST_SAVING.toString()} pts
          </Button>
        </div>
      </div>

      {/* Outcome of the off-chain comparison. Drives what the user can do next. */}
      <CostSavingHint
        requestId={requestId}
        awardedId={awardedId}
        saving={saving}
        pending={tx.pending}
      />

      <ResultBanner
        pending={tx.pending}
        signature={tx.signature}
        error={tx.error}
        onDismiss={tx.reset}
      />
    </SubPanel>
  );
}

/**
 * Explain the off-chain comparison result: a detected saving (with the award
 * enabled), a non-saving, or no comparison data at all. Pure presentational.
 */
function CostSavingHint({
  requestId,
  awardedId,
  saving,
  pending,
}: {
  requestId: bigint | null;
  awardedId: bigint | null;
  saving: { isSaving: boolean; savingPerUnitLamports: bigint } | null;
  pending: boolean;
}) {
  // Nothing typed yet — stay quiet (calm UX, mirrors the field-error convention).
  if (requestId === null) return null;

  // Just awarded this request in this session — confirm it (the snapshot has
  // been consumed, so `saving` will have recomputed to null; surface success
  // rather than the generic "no data" message).
  if (awardedId !== null && awardedId === requestId) {
    return (
      <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-4 py-3 text-xs text-emerald-700 dark:text-emerald-200">
        Done — the buyer earned {REWARD_COST_SAVING.toString()} cost-saving
        reward points. The on-chain receipt above is the audit trail.
      </p>
    );
  }

  if (saving === null) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
        No comparison data for this request on this device. That happens when
        the snapshot or the actual cost was typed by hand (not set via “Compare
        prices”), when this is a different browser than the one that recorded
        it, or after a reload. You can still award points manually in Rewards.
      </p>
    );
  }

  if (saving.isSaving) {
    return (
      <p className="rounded-lg border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-4 py-3 text-xs text-emerald-700 dark:text-emerald-200">
        {pending
          ? "Awarding the cost-saving reward…"
          : `Smart saving detected — the buyer paid less per unit than the snapshot benchmark (saving ${
              saving.savingPerUnitLamports
            } lamports/g). Award them ${REWARD_COST_SAVING.toString()} points.`}
      </p>
    );
  }

  return (
    <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
      No saving on this request — the buyer didn't beat the best-value snapshot,
      so no cost-saving reward is due.
    </p>
  );
}

// ---------------------------------------------------------------------------
// close_purchase_request
// ---------------------------------------------------------------------------

function CloseForm() {
  const program = useProgram();
  const { household, connectedWallet, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const { requestIdInput, setRequestIdInput, requestId, requestIdError } =
    useRequestIdInput();

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    requestId !== null &&
    !requestIdError &&
    !tx.pending;

  const handleSubmit = () => {
    if (!program || !household || !connectedWallet || requestId === null)
      return;
    const accounts = buildRequestAccounts(
      household,
      connectedWallet,
      requestId
    );
    if (!accounts) return;
    void tx.submit(async () => {
      // close_purchase_request: Owner/Parent closes a terminal-state request
      // (reimbursed or rejected) and reclaims rent. The caller account is
      // mut because it receives the closed PDA's lamports.
      return program.methods
        .closePurchaseRequest()
        .accountsStrict(accounts)
        .rpc();
    });
  };

  // Owner/Parent gate: the program rejects any non-Owner/Parent caller
  // with `UnauthorizedRole`. Surface a clear hint up-front (mirroring
  // FundsPanel's withdraw gate and RewardsPanel's award gate) rather than
  // letting the user discover it via a failed transaction.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="Close the request"
        hint="Admin or approver. Sign in as the household admin (or set the admin address above to your account) to close requests."
      >
        <p className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 px-4 py-3 text-xs text-stone-500 dark:text-slate-400">
          You're not signed in as this household's admin. Closures are
          admin-only in this reference UI; the on-chain gate also admits the
          Parent role.
        </p>
      </SubPanel>
    );
  }

  return (
    <SubPanel
      label="Close the request"
      hint="Admin or approver. Closes a finished request (paid back or declined) and reclaims its deposit. Can't close a request that's still in progress."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field
          label="Request #"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
            variant="secondary"
          >
            Close request
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
