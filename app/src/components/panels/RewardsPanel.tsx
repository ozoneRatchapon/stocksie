"use client";

// RewardsPanel — manual point grants and read-only score emits.
//
// Two instructions, both reading the same { household, callerMember, caller }
// account trio for auth, differing in what they do:
//
//   - `award_reward`   : Owner/Parent grants arbitrary points to any active
//     member for any reason. `targetMember` is seeded by the `member_wallet`
//     arg (so the caller may target any member, not just themselves); the
//     reason text is blake3-hashed off-chain by the client and passed as
//     `reason_hash`. The points + the household's `total_rewards_distributed`
//     accumulator move in lockstep (audit pair).
//   - `reward_summary` : any active member emits a read-only `RewardEarned`
//     event carrying their current cumulative score. The points field is 0 and
//     the reason hash is the all-zero sentinel, so auditors can distinguish a
//     score-fetch from a real grant. Touches no state — useful for clients that
//     consume the event stream instead of deserializing `Member` accounts.
//
// Both instructions surface a transaction signature on success: even
// `reward_summary`, though it mutates nothing, still consumes a slot and emits
// an event, so showing the signature is honest (and lets the user open the tx
// in Explorer to see the emitted `RewardEarned` log).

import { useMemo, useState } from "react";
import BN from "bn.js";
import { useProgram } from "@/lib/program";
import { useHouseholdContext } from "@/hooks/useHouseholdContext";
import { useTransactionWithRefresh as useTransaction } from "@/hooks/useRefresh";
import { memberPda } from "@/lib/accounts";
import { toHash32 } from "@/lib/hashes";
import { tryParsePublicKey, tryParseUint64 } from "@/lib/parse";
import { Panel, SubPanel } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";
import { ConnectGate } from "@/components/ui/ConnectGate";

export function RewardsPanel() {
  return (
    <Panel
      title="Rewards"
      description="Manually grant points to a member (Owner/Parent) or emit a read-only score summary (any member). Rewards are an audit-stream feature — the raw reason text is blake3-hashed client-side and never lands on-chain."
    >
      <ConnectGate>
        <AwardRewardForm />
        <RewardSummaryForm />
      </ConnectGate>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// award_reward (Owner/Parent only)
// ---------------------------------------------------------------------------

function AwardRewardForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember, isOwnerConnected } =
    useHouseholdContext();
  const tx = useTransaction();
  const [memberInput, setMemberInput] = useState("");
  const [pointsInput, setPointsInput] = useState("");
  const [reasonInput, setReasonInput] = useState("");

  const memberWallet = useMemo(
    () => tryParsePublicKey(memberInput),
    [memberInput]
  );
  const points = useMemo(() => tryParseUint64(pointsInput), [pointsInput]);

  const memberError = useMemo(() => {
    if (memberInput.trim().length === 0) return null;
    return memberWallet ? null : "Invalid Solana address";
  }, [memberInput, memberWallet]);

  const pointsError = useMemo(() => {
    if (pointsInput.trim().length === 0) return null;
    if (points === null) return "Enter a whole number of points";
    if (points <= 0n) return "Points must be greater than zero";
    return null;
  }, [pointsInput, points]);

  // Owner/Parent gate: the program rejects any non-Owner/Parent caller with
  // `UnauthorizedRole`. Surface a clear hint up-front (mirroring FundsPanel's
  // withdraw gate and HouseholdPanel's manage-members gate) rather than letting
  // the user discover it via a failed transaction. We use `isOwnerConnected`
  // as a conservative proxy: in the MVP, the reward authority (`can_award_rewards`)
  // and the owner are the same role set, and the UI cannot read the connected
  // wallet's role without an extra account fetch — the program is the source of
  // truth, this gate is just a UX guard.
  if (!isOwnerConnected) {
    return (
      <SubPanel
        label="award_reward"
        hint="Owner/Parent. Connect the household owner wallet (or set the owner field above to your wallet) to grant rewards."
      >
        <p className="rounded-lg border border-dashed border-slate-700 bg-slate-950/30 px-4 py-3 text-xs text-slate-400">
          The connected wallet is not the resolved household owner. Manual
          rewards are restricted to the owner in this reference UI; the on-chain
          gate admits Owner and Parent roles.
        </p>
      </SubPanel>
    );
  }

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !!memberWallet &&
    points !== null &&
    points > 0n &&
    reasonInput.trim().length > 0 &&
    !memberError &&
    !pointsError &&
    !tx.pending;

  const handleSubmit = () => {
    if (
      !program ||
      !household ||
      !connectedWallet ||
      !callerMember ||
      !memberWallet ||
      points === null ||
      reasonInput.trim().length === 0
    ) {
      return;
    }
    const targetMember = memberPda(household, memberWallet);
    const reasonHash = toHash32(reasonInput);
    void tx.submit(async () => {
      // award_reward(member_wallet, points, reason_hash): positional args are
      // the target wallet pubkey, the u64 point count, and the blake3 reason
      // digest. The target Member PDA is seeded by `member_wallet`, so the
      // caller may target any active member — not just themselves.
      return program.methods
        .awardReward(memberWallet, new BN(points.toString()), reasonHash)
        .accountsStrict({
          household,
          callerMember,
          targetMember,
          caller: connectedWallet,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="award_reward"
      hint="Owner/Parent. Grant points to any active member for any reason. The member's reward_points and the household's total_rewards_distributed both increment. Reason text is blake3-hashed before submission."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Member wallet"
          value={memberInput}
          onChange={setMemberInput}
          placeholder="Base58 address"
          mono
          error={memberError}
          onSubmit={handleSubmit}
          helpText="The member being rewarded — can be any active member of this household."
        />
        <Field
          label="Points"
          value={pointsInput}
          onChange={setPointsInput}
          type="number"
          placeholder="e.g. 25"
          min="1"
          step="1"
          mono
          error={pointsError}
          onSubmit={handleSubmit}
          helpText="Whole number of points to grant. Must be greater than zero."
        />
        <Field
          label="Reason (hashed)"
          value={reasonInput}
          onChange={setReasonInput}
          placeholder='e.g. "Found a coupon for the diapers"'
          helpText="Blake3-hashed client-side; only the 32-byte digest is stored on-chain."
          onSubmit={handleSubmit}
          className="sm:col-span-2"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
        >
          Award Reward
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
// reward_summary (any active member, read-only)
// ---------------------------------------------------------------------------

function RewardSummaryForm() {
  const program = useProgram();
  const { household, connectedWallet, callerMember } = useHouseholdContext();
  const tx = useTransaction();

  const canSubmit =
    !!program &&
    !!household &&
    !!connectedWallet &&
    !!callerMember &&
    !tx.pending;

  const handleSubmit = () => {
    if (!program || !household || !connectedWallet || !callerMember) return;
    void tx.submit(async () => {
      // reward_summary takes no args. It emits a RewardEarned event with
      // points=0 and an all-zero reason_hash sentinel so auditors can
      // distinguish a score-fetch from a real grant; the caller's current
      // cumulative reward_points rides on the event's `total_points` field.
      return program.methods
        .rewardSummary()
        .accountsStrict({
          household,
          callerMember,
          caller: connectedWallet,
        })
        .rpc();
    });
  };

  return (
    <SubPanel
      label="reward_summary"
      hint="Any active member. Emits a read-only RewardEarned event carrying your current cumulative score (points=0, all-zero hash sentinel distinguishes it from a real grant). Useful when consuming the event stream instead of deserializing Member accounts."
    >
      <div className="flex items-center gap-3">
        <Button
          onClick={handleSubmit}
          loading={tx.pending}
          disabled={!canSubmit}
          variant="secondary"
        >
          Emit Summary
        </Button>
        <span className="text-xs text-slate-500">
          No state change — the StateView below reads scores directly from your
          Member account.
        </span>
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
