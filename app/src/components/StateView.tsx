'use client';

// StateView — the live read-side mirror of the on-chain household state.
//
// Consumes the data fetched by `useHousehold` (which polls the household +
// members + purchase requests every 1.5s and refetches immediately on any
// confirmed write via the shared `useRefresh` nonce) and renders it as three
// stacked sections inside one Panel:
//
//   1. Vault summary       — vault balance in SOL, member count, request count,
//                            and total rewards distributed. The "not yet
//                            initialized" state gets its own hint rather than
//                            a zeroed-out card.
//   2. Member roster       — every active (and recently-closed) member PDA in
//                            the household, with role badges, reward points,
//                            and the joined slot. Sorted owner-first for
//                            visual hierarchy.
//   3. Purchase ledger     — every purchase request, newest-first, with status
//                            badges, the buyer wallet, the spend ceiling, and
//                            the reward earned so far.
//
// The owner-address resolution flows in from `useHouseholdContext`: the same
// field that drives the instruction panels. So the StateView always reflects
// the household the user is actively transacting against.

import { useMemo } from 'react';
import { useHouseholdContext } from '@/hooks/useHouseholdContext';
import { useHousehold, type MemberAccount, type PurchaseRequestAccount } from '@/hooks/useHousehold';
import { useRefresh } from '@/hooks/useRefresh';
import { lamportsToSol, shortPubkey } from '@/lib/format';
import { roleFromAnchor, statusFromAnchor, type Role, type Status } from '@/lib/types';
import { Panel } from '@/components/ui/Panel';
import { Badge, RoleBadge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';

export function StateView() {
  const { household, ownerInput, setOwnerInput, ownerInputError, isOverridden, resetToConnectedWallet } =
    useHouseholdContext();
  const { nonce } = useRefresh();
  const state = useHousehold(nonce);

  return (
    <Panel
      title="Your household"
      description="A live view of your shared budget, who's in the household, and every shopping request. Updates automatically after every action you take."
      actions={
        <Button
          variant="secondary"
          size="sm"
          onClick={state.refetch}
          loading={state.refreshing}
          disabled={!household}
        >
          Refresh
        </Button>
      }
    >
      <OwnerField
        value={ownerInput}
        onChange={setOwnerInput}
        error={ownerInputError}
        overridden={isOverridden}
        onReset={resetToConnectedWallet}
      />

      {!household ? (
        <EmptyState
          title="No household loaded yet"
          body="Enter the household admin's address above to load your household. It defaults to your own address when you're signed in."
        />
      ) : state.loading ? (
        <LoadingState />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.refetch} />
      ) : !state.data || !state.data.household ? (
        <EmptyState
          title="This household hasn't been set up yet"
          body="Once the admin sets up the household (in the Household section below), the shared budget, members, and shopping requests will all show up here."
        />
      ) : (
        <HouseholdSections data={state.data} refreshing={state.refreshing} />
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Owner-address field (the household seed basis)
// ---------------------------------------------------------------------------

function OwnerField({
  value,
  onChange,
  error,
  overridden,
  onReset,
}: {
  value: string;
  onChange: (v: string) => void;
  error: string | null;
  overridden: boolean;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <Field
        label="Household admin address"
        value={value}
        onChange={onChange}
        placeholder="The admin's wallet address (defaults to your account)"
        mono
        error={error}
        helpText="Your household is tied to its admin's address. Change this if you joined a household someone else set up."
        className="sm:flex-1"
      />
      {overridden && (
        <Button variant="ghost" size="sm" onClick={onReset} className="sm:mb-1.5">
          Use my address
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main sections — vault summary, member roster, purchase ledger
// ---------------------------------------------------------------------------

function HouseholdSections({
  data,
  refreshing,
}: {
  data: NonNullable<ReturnType<typeof useHousehold>['data']>;
  refreshing: boolean;
}) {
  const { household, members, requests } = data;

  // Sort members owner-first, then by joined slot (stable, auditable ordering).
  const sortedMembers = useMemo(() => sortMembers(members), [members]);
  // Sort requests newest-first (highest request id on top).
  const sortedRequests = useMemo(() => sortRequests(requests), [requests]);

  return (
    <div className="flex flex-col gap-5">
      <VaultSummary household={household} address={data.address} refreshing={refreshing} />
      <MemberRoster members={sortedMembers} />
      <PurchaseLedger requests={sortedRequests} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vault summary
// ---------------------------------------------------------------------------

function VaultSummary({
  household,
  address,
  refreshing,
}: {
  household: NonNullable<ReturnType<typeof useHousehold>['data']>['household'];
  address: NonNullable<ReturnType<typeof useHousehold>['data']>['address'];
  refreshing: boolean;
}) {
  if (!household) return null;
  const vaultSol = lamportsToSol(household.vaultBalance);
  const totalRewards = household.totalRewardsDistributed.toString(10);
  const requestCounter = household.requestCounter.toString(10);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Shared budget"
        value={`${vaultSol} SOL`}
        accent
        sub={refreshing ? 'updating…' : undefined}
      />
      <StatCard label="Members" value={String(household.memberCount)} sub={`of 16 max`} />
      <StatCard label="Shopping requests" value={requestCounter} sub="total, all time" />
      <StatCard label="Reward points given out" value={totalRewards} sub="across everyone" />
      <div className="sm:col-span-2 lg:col-span-4">
        <MetaRow label="Household address" value={address.toBase58()} mono />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-lg border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-950/50 p-4">
      <div className="text-xs uppercase tracking-wide text-stone-500 dark:text-slate-500">{label}</div>
      <div
        className={`mt-1 truncate font-mono text-lg font-semibold ${
          accent ? 'text-emerald-600 dark:text-emerald-400' : 'text-stone-800 dark:text-slate-100'
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-stone-400 dark:text-slate-600">{sub}</div>}
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 dark:border-slate-800/70 bg-stone-50/60 dark:bg-slate-950/40 px-4 py-2">
      <span className="text-xs uppercase tracking-wide text-stone-500 dark:text-slate-500">{label}</span>
      <code
        className={`truncate text-xs text-stone-500 dark:text-slate-400 ${mono ? 'font-mono' : ''}`}
        title={value}
      >
        {value}
      </code>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member roster
// ---------------------------------------------------------------------------

function MemberRoster({ members }: { members: MemberAccount[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-slate-300">
          Members
        </h3>
        <span className="text-xs text-stone-500 dark:text-slate-500">{members.length} active</span>
      </div>
      {members.length === 0 ? (
        <EmptyState
          title="No members yet"
          body="Once someone is invited, they'll show up here. The admin who set up the household appears automatically."
          compact
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-stone-100/80 dark:bg-slate-900/60 text-xs uppercase tracking-wide text-stone-500 dark:text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Member</th>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                <th className="px-3 py-2 text-right font-medium">Reward points</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-slate-800/70">
              {members.map((m) => (
                <MemberRow key={m.publicKey.toBase58()} member={m} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MemberRow({ member }: { member: MemberAccount }) {
  const role = roleFromAnchor(member.account.role) ?? 'guest';
  const rewardPoints = member.account.rewardPoints.toString(10);
  const isActive = member.account.active;

  return (
    <tr className="bg-stone-50/50 dark:bg-slate-950/30 hover:bg-white dark:hover:bg-slate-900/40">
      <td className="px-3 py-2 font-mono text-xs text-stone-700 dark:text-slate-200" title={member.account.wallet.toBase58()}>
        {shortPubkey(member.account.wallet)}
      </td>
      <td className="px-3 py-2">
        <RoleBadge role={role as Role} />
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-stone-600 dark:text-slate-300">{rewardPoints}</td>
      <td className="px-3 py-2">
        {isActive ? (
          <Badge className="bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 ring-emerald-500/30">Active</Badge>
        ) : (
          <Badge className="bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300 ring-rose-500/30">Inactive</Badge>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Purchase ledger
// ---------------------------------------------------------------------------

function PurchaseLedger({ requests }: { requests: PurchaseRequestAccount[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-slate-300">
          Shopping requests
        </h3>
        <span className="text-xs text-stone-500 dark:text-slate-500">{requests.length} request(s)</span>
      </div>
      {requests.length === 0 ? (
        <EmptyState
          title="No shopping requests yet"
          body="When someone reports something the household needs, it'll appear here. Open one in the Shopping section below."
          compact
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-stone-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-stone-100/80 dark:bg-slate-900/60 text-xs uppercase tracking-wide text-stone-500 dark:text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">#</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Buyer</th>
                <th className="px-3 py-2 text-right font-medium">Spending limit</th>
                <th className="px-3 py-2 text-right font-medium">Paid back</th>
                <th className="px-3 py-2 text-right font-medium">Reward</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 dark:divide-slate-800/70">
              {requests.map((r) => (
                <RequestRow key={r.publicKey.toBase58()} request={r} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RequestRow({ request }: { request: PurchaseRequestAccount }) {
  const status = statusFromAnchor(request.account.status) ?? 'pending';
  const amountSol = lamportsToSol(request.account.amountLamports);
  const reimbursedSol = lamportsToSol(request.account.reimbursedAmount);
  const rewardEarned = request.account.rewardEarned.toString(10);
  const requestId = request.account.requestId.toString(10);

  return (
    <tr className="bg-stone-50/50 dark:bg-slate-950/30 hover:bg-white dark:hover:bg-slate-900/40">
      <td className="px-3 py-2 font-mono text-xs text-stone-600 dark:text-slate-300">#{requestId}</td>
      <td className="px-3 py-2">
        <StatusBadge status={status as Status} />
      </td>
      <td className="px-3 py-2 font-mono text-xs text-stone-700 dark:text-slate-200" title={request.account.buyer.toBase58()}>
        {shortPubkey(request.account.buyer)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-stone-600 dark:text-slate-300">{amountSol} SOL</td>
      <td className="px-3 py-2 text-right font-mono text-xs text-stone-500 dark:text-slate-400">
        {reimbursedSol} SOL
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-emerald-600/80 dark:text-emerald-300/80">{rewardEarned}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// State placeholders
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-stone-200 dark:border-slate-800 bg-stone-50/50 dark:bg-slate-950/30 px-5 py-8 text-sm text-stone-500 dark:text-slate-400">
      <Spinner />
      Loading your household…
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 px-5 py-4">
      <p className="text-sm font-medium text-rose-700 dark:text-rose-200">Couldn't load your household</p>
      <p className="break-words text-xs text-rose-700/80 dark:text-rose-200/80">{message}</p>
      <div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function EmptyState({
  title,
  body,
  compact,
}: {
  title: string;
  body: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1 rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 ${
        compact ? 'px-4 py-3' : 'px-5 py-6'
      }`}
    >
      <p className="text-sm font-medium text-stone-600 dark:text-slate-300">{title}</p>
      <p className="text-xs leading-relaxed text-stone-500 dark:text-slate-500">{body}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sorting + spinner helpers
// ---------------------------------------------------------------------------

/**
 * Sort members owner-first, then by joined slot ascending. The owner is always
 * listed first (matches the on-chain "one owner per household" invariant and
 * gives the roster a stable visual hierarchy).
 */
function sortMembers(members: MemberAccount[]): MemberAccount[] {
  return [...members].sort((a, b) => {
    const roleA = roleFromAnchor(a.account.role);
    const roleB = roleFromAnchor(b.account.role);
    const aOwner = roleA === 'owner' ? 0 : 1;
    const bOwner = roleB === 'owner' ? 0 : 1;
    if (aOwner !== bOwner) return aOwner - bOwner;
    // Secondary sort: joined slot ascending (oldest membership first). Use the
    // base-10 string compare via BigInt to avoid `toNumber()` overflow.
    const slotA = BigInt(a.account.joinedSlot.toString(10));
    const slotB = BigInt(b.account.joinedSlot.toString(10));
    if (slotA < slotB) return -1;
    if (slotA > slotB) return 1;
    return 0;
  });
}

/**
 * Sort requests newest-first (highest request id on top). Falls back to
 * created-slot ordering if request ids tie (defensive — ids are unique per
 * household, so this branch should never fire).
 */
function sortRequests(requests: PurchaseRequestAccount[]): PurchaseRequestAccount[] {
  return [...requests].sort((a, b) => {
    const idA = BigInt(a.account.requestId.toString(10));
    const idB = BigInt(b.account.requestId.toString(10));
    if (idA > idB) return -1;
    if (idA < idB) return 1;
    const slotA = BigInt(a.account.createdSlot.toString(10));
    const slotB = BigInt(b.account.createdSlot.toString(10));
    if (slotA > slotB) return -1;
    if (slotA < slotB) return 1;
    return 0;
  });
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-stone-500 dark:text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
