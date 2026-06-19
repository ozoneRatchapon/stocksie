// Status / role badge — a small colored pill that renders a Stocksie enum.
//
// Two specialized variants over the same primitive:
//   - <StatusBadge status="approved" />     — purchase-lifecycle state
//   - <RoleBadge role="parent" />           — household member privilege
//
// Colors are chosen so the lifecycle reads left-to-right as a progression
// (neutral pending → positive approved → cool restocked → done reimbursed,
// rejected in red as the only failure terminal state) and so roles are
// visually ranked (owner gold, parent blue, child slate, guest muted).
// Tailwind classes are picked per-value at module scope (not built up
// conditionally) so Tailwind's compiler can statically see every class.

import { cn } from '@/lib/cn';
import { ROLE_LABELS, STATUS_LABELS, type Role, type Status } from '@/lib/types';

const STATUS_CLASSES: Record<Status, string> = {
  pending: 'bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300 ring-amber-500/30',
  approved: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 ring-emerald-500/30',
  restocked: 'bg-sky-50 dark:bg-sky-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/30',
  reimbursed: 'bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300 ring-violet-500/30',
  rejected: 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300 ring-rose-500/30',
};

const ROLE_CLASSES: Record<Role, string> = {
  owner: 'bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300 ring-amber-500/30',
  parent: 'bg-sky-50 dark:bg-sky-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/30',
  child: 'bg-stone-200 dark:bg-slate-500/15 text-stone-700 dark:text-slate-200 ring-stone-400/30 dark:ring-slate-400/30',
  guest: 'bg-zinc-100 dark:bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 ring-zinc-500/30',
};

const BASE_CLASS =
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap';

type BadgeProps = {
  className?: string;
  children: React.ReactNode;
};

/** Generic colored pill. Prefer the typed wrappers below for enum values. */
export function Badge({ className, children }: BadgeProps) {
  return <span className={cn(BASE_CLASS, className)}>{children}</span>;
}

/** Render a purchase-lifecycle `Status` as a labeled, color-coded pill. */
export function StatusBadge({ status, className }: { status: Status; className?: string }) {
  return (
    <Badge className={cn(STATUS_CLASSES[status], className)}>{STATUS_LABELS[status]}</Badge>
  );
}

/**
 * Render a household member `Role` as a labeled, color-coded pill.
 *
 * Note: `ROLE_LABELS.owner` is "Owner" here for clarity inside this badge
 * surface (the role enum is the on-chain source of truth). The rest of the
 * UI surfaces the owner concept as "admin" in user-facing copy — see
 * `.plans/005_web2_ux.md` §3 (vocabulary table).
 */
export function RoleBadge({ role, className }: { role: Role; className?: string }) {
  return <Badge className={cn(ROLE_CLASSES[role], className)}>{ROLE_LABELS[role]}</Badge>;
}
