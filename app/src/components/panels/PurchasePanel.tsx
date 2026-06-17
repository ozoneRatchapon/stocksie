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
} from "@/lib/constants";
import { Panel, SubPanel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";
import { ConnectGate } from "@/components/ui/ConnectGate";

export function PurchasePanel() {
  return (
    <Panel
      title="Purchase Requests"
      description="Open a purchase request as a low-stock reporter, then approve, reject, confirm restock, or close it. The full lifecycle (pending → approved → restocked → reimbursed, or rejected) runs through these five instructions."
    >
      <ConnectGate>
        <CreateForm />
        <ApproveForm />
        <RejectForm />
        <ConfirmRestockForm />
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

  const itemError =
    itemInput.trim().length === 0 && amountInput.trim().length > 0
      ? null
      : null; // item/unit-cost are free text; only required at submit time
  const unitCostError = null;
  void itemError;
  void unitCostError;

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
    void tx.submit(async () => {
      // The request PDA uses `request_counter + 1` — the *next* id, which the
      // handler commits via Household::next_request_id. Reading the household
      // here (rather than trusting a cached counter) closes the race window
      // where a concurrent request could have bumped the counter.
      const householdAccount = await program.account.household.fetch(household);
      const nextId = householdAccount.requestCounter.toNumber() + 1;
      const request = purchasePda(household, nextId);
      return program.methods
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
    });
  };

  return (
    <SubPanel
      label="create_purchase_request"
      hint="Open a request as the low-stock reporter. You earn REWARD_LOW_STOCK_REPORT (10 pts). The buyer must be an active member of this household. Item / unit-cost text is blake3-hashed before submission."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Amount (spend ceiling)"
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
          label="Buyer wallet"
          value={buyerInput}
          onChange={setBuyerInput}
          placeholder="Base58 address"
          mono
          error={buyerError}
          onSubmit={handleSubmit}
          helpText="The member who will make the purchase and confirm restock."
        />
        <Field
          label="Item / quantity (hashed)"
          value={itemInput}
          onChange={setItemInput}
          placeholder='e.g. "Pampers Size 3, 2 boxes"'
          helpText="Blake3-hashed; raw text stays off-chain."
          onSubmit={handleSubmit}
        />
        <Field
          label="Best-value snapshot (hashed)"
          value={unitCostInput}
          onChange={setUnitCostInput}
          placeholder='e.g. "Lowest unit price at store X"'
          helpText="Blake3-hashed; the off-chain engine scores cost-savings against this snapshot."
          onSubmit={handleSubmit}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
        >
          Create Request
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
  const { household, connectedWallet } = useHouseholdContext();
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

  return (
    <SubPanel
      label="approve_purchase_request"
      hint="Owner/Parent. Marks a pending request as approved and records the approver wallet on the request."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field
          label="Request ID"
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
  const { household, connectedWallet } = useHouseholdContext();
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

  return (
    <SubPanel
      label="reject_purchase_request"
      hint="Owner/Parent. Moves a pending request to rejected. The reason is blake3-hashed client-side — the raw text never lands on-chain."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_auto]">
        <Field
          label="Request ID"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
        />
        <Field
          label="Reason (hashed)"
          value={reasonInput}
          onChange={setReasonInput}
          placeholder='e.g. "Already have enough at home"'
          helpText="Blake3-hashed; stored only as a 32-byte digest."
          onSubmit={handleSubmit}
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
            variant="danger"
          >
            Reject
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
    void tx.submit(async () => {
      // confirm_restock is called BY the buyer. Account names: household,
      // buyerMember, request, buyer. The buyer (not "caller") is the signer.
      return program.methods
        .confirmRestock(unitCostHash)
        .accountsStrict({
          household,
          buyerMember,
          request,
          buyer: buyerWallet,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="confirm_restock"
      hint="The buyer confirms they restocked the item. Earns REWARD_RESTOCK_COMPLETED (25 pts). The unit-cost snapshot may differ from the create-time one — record what the buyer actually picked."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr_2fr_auto]">
        <Field
          label="Request ID"
          value={requestIdInput}
          onChange={setRequestIdInput}
          placeholder="e.g. 1"
          mono
          error={requestIdError}
          onSubmit={handleSubmit}
        />
        <Field
          label="Buyer wallet"
          value={buyerInput}
          onChange={setBuyerInput}
          placeholder="Base58 address"
          mono
          error={buyerError}
          onSubmit={handleSubmit}
          helpText="The buyer signs; restock is buyer-only."
        />
        <Field
          label="Actual unit cost (hashed)"
          value={unitCostInput}
          onChange={setUnitCostInput}
          placeholder='e.g. "Cheapest pack at store Y"'
          helpText="Blake3-hashed."
          onSubmit={handleSubmit}
        />
        <div className="flex items-end">
          <Button
            onClick={handleSubmit}
            loading={tx.pending}
            disabled={!canSubmit}
          >
            Confirm Restock
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
// close_purchase_request
// ---------------------------------------------------------------------------

function CloseForm() {
  const program = useProgram();
  const { household, connectedWallet } = useHouseholdContext();
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

  return (
    <SubPanel
      label="close_purchase_request"
      hint="Owner/Parent. Closes a terminal-state request (reimbursed or rejected) and reclaims rent. Cannot close a mid-lifecycle request."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field
          label="Request ID"
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
            Close Request
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
