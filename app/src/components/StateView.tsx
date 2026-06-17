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
      title="Live State"
      description="On-chain mirror of the resolved household: vault balance, member roster, and purchase ledger. Polls every 1.5s and refetches immediately after every confirmed transaction."
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
          title="No household resolved"
          body="Enter a household owner address above to derive the household PDA and load its state. The field defaults to your connected wallet."
        />
      ) : state.loading ? (
        <LoadingState />
      ) : state.error ? (
        <ErrorState message={state.error} onRetry={state.refetch} />
      ) : !state.data || !state.data.household ? (
        <EmptyState
          title="Household not initialized"
          body="This household PDA has no on-chain account yet. Run initialize_household (in the Household panel) to create it — the vault, member roster, and purchase ledger will populate here."
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
        label="Household owner address"
        value={value}
        onChange={onChange}
        placeholder="Base58 owner pubkey (defaults to connected wallet)"
        mono
        error={error}
        helpText="The household PDA is derived from its owner. Override this to view a household you are a member of but did not create."
        className="sm:flex-1"
      />
      {overridden && (
        <Button variant="ghost" size="sm" onClick={onReset} className="sm:mb-1.5">
          Reset to connected wallet
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
        label="Vault balance"
        value={`${vaultSol} SOL`}
        accent
        sub={refreshing ? 'refreshing…' : undefined}
      />
      <StatCard label="Members" value={String(household.memberCount)} sub={`of 16 max`} />
      <StatCard label="Requests created" value={requestCounter} sub="total, all time" />
      <StatCard label="Rewards distributed" value={totalRewards} sub="points, cumulative" />
      <div className="sm:col-span-2 lg:col-span-4">
        <MetaRow label="Household PDA" value={address.toBase58()} mono />
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
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`mt-1 truncate font-mono text-lg font-semibold ${
          accent ? 'text-emerald-400' : 'text-slate-100'
        }`}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-slate-600">{sub}</div>}
    </div>
  );
}

function MetaRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-800/70 bg-slate-950/40 px-4 py-2">
      <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
      <code
        className={`truncate text-xs text-slate-400 ${mono ? 'font-mono' : ''}`}
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
          Member roster
        </h3>
        <span className="text-xs text-slate-500">{members.length} active</span>
      </div>
      {members.length === 0 ? (
        <EmptyState
          title="No members found"
          body="No Member PDAs reference this household. If you just initialized, the owner membership should appear momentarily."
          compact
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Wallet</th>
                <th className="px-3 py-2 text-left font-medium">Role</th>
                <th className="px-3 py-2 text-right font-medium">Reward points</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
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
    <tr className="bg-slate-950/30 hover:bg-slate-900/40">
      <td className="px-3 py-2 font-mono text-xs text-slate-200" title={member.account.wallet.toBase58()}>
        {shortPubkey(member.account.wallet)}
      </td>
      <td className="px-3 py-2">
        <RoleBadge role={role as Role} />
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{rewardPoints}</td>
      <td className="px-3 py-2">
        {isActive ? (
          <Badge className="bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">Active</Badge>
        ) : (
          <Badge className="bg-rose-500/15 text-rose-300 ring-rose-500/30">Inactive</Badge>
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
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
          Purchase ledger
        </h3>
        <span className="text-xs text-slate-500">{requests.length} request(s)</span>
      </div>
      {requests.length === 0 ? (
        <EmptyState
          title="No purchase requests"
          body="Create one in the Purchase Requests panel. New requests appear here as soon as they confirm."
          compact
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-slate-800">
          <table className="w-full text-sm">
            <thead className="bg-slate-900/60 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">ID</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Buyer</th>
                <th className="px-3 py-2 text-right font-medium">Ceiling</th>
                <th className="px-3 py-2 text-right font-medium">Reimbursed</th>
                <th className="px-3 py-2 text-right font-medium">Reward</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
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
    <tr className="bg-slate-950/30 hover:bg-slate-900/40">
      <td className="px-3 py-2 font-mono text-xs text-slate-300">#{requestId}</td>
      <td className="px-3 py-2">
        <StatusBadge status={status as Status} />
      </td>
      <td className="px-3 py-2 font-mono text-xs text-slate-200" title={request.account.buyer.toBase58()}>
        {shortPubkey(request.account.buyer)}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{amountSol} SOL</td>
      <td className="px-3 py-2 text-right font-mono text-xs text-slate-400">
        {reimbursedSol} SOL
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs text-emerald-300/80">{rewardEarned}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// State placeholders
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/30 px-5 py-8 text-sm text-slate-400">
      <Spinner />
      Loading household state…
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-5 py-4">
      <p className="text-sm font-medium text-rose-200">Failed to load household state</p>
      <p className="break-words text-xs text-rose-200/80">{message}</p>
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
      className={`flex flex-col gap-1 rounded-lg border border-dashed border-slate-700 bg-slate-950/30 ${
        compact ? 'px-4 py-3' : 'px-5 py-6'
      }`}
    >
      <p className="text-sm font-medium text-slate-300">{title}</p>
      <p className="text-xs leading-relaxed text-slate-500">{body}</p>
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
    <svg className="h-4 w-4 animate-spin text-slate-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
