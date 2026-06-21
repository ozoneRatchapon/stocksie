// StatusStepper — a horizontal lifecycle progress bar that replaces the flat
// <StatusBadge> pill on each purchase card.
//
// Visualizes the FULL 5-state `Status` enum (`lib/types.ts`), not just the
// 3-state "Pending → Approved → Restocked" path from the original design
// brief. Stocksie's real lifecycle is 4 steps on the success branch
// (pending → approved → restocked → reimbursed) with `rejected` rendered
// as a distinct terminal indicator (red), because rejection can occur at
// either `pending` or `approved` and the on-chain status alone does not
// record which step was rejected — so we cannot honestly plot it on the
// success line.
//
// Read-only presentational component. Same prop shape as <StatusBadge>
// (`status` + optional `className`) — drop-in replacement.
//
// Tailwind classes are picked per-state at module scope (same pattern as
// Badge.tsx) so the static compiler sees every class — no computed names.

import { cn } from "@/lib/cn";
import { STATUS_LABELS, type Status } from "@/lib/types";

type SuccessStatus = Exclude<Status, "rejected">;

// Lifecycle order, success branch.
const SUCCESS_PATH: readonly SuccessStatus[] = [
  "pending",
  "approved",
  "restocked",
  "reimbursed",
];

// Per-step glyph. Emoji match the vocabulary used across the rest of the
// app (🕐 wait, ✓ confirm, 🛒 buy, 💸 pay back). The "done" override below
// replaces whichever icon with a checkmark once the step is complete.
const STEP_ICON: Record<SuccessStatus, string> = {
  pending: "🕐",
  approved: "✓",
  restocked: "🛒",
  reimbursed: "💸",
};

type NodeState = "done" | "active" | "future";

// ---- Module-scope class strings (Tailwind static-analysis friendly) ----

const NODE_BASE =
  "flex h-6 w-6 flex-none items-center justify-center rounded-full text-[10px] font-semibold ring-1 ring-inset";

const NODE_DONE =
  "bg-emerald-500 text-white ring-emerald-500 dark:bg-emerald-400 dark:text-emerald-950 dark:ring-emerald-400";

const NODE_ACTIVE =
  "bg-emerald-50 text-emerald-700 ring-emerald-500/60 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/60";

const NODE_FUTURE =
  "bg-white text-stone-300 ring-stone-200 dark:bg-slate-900/40 dark:text-slate-600 dark:ring-slate-700";

const CONNECTOR_BASE = "h-0.5 w-3 flex-none sm:w-4";

const CONNECTOR_DONE = "bg-emerald-500 dark:bg-emerald-400";

const CONNECTOR_FUTURE = "bg-stone-200 dark:bg-slate-700";

const LABEL_CLASS = "text-xs font-medium text-stone-600 dark:text-slate-300";

const REJECTED_CLASS =
  "inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-medium text-rose-600 ring-1 ring-inset ring-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300 dark:ring-rose-500/30";

export function StatusStepper({
  status,
  className,
}: {
  status: Status;
  className?: string;
}) {
  // Rejected is a terminal failure that bypasses the success path. Render
  // a distinct red indicator rather than forcing it onto the progress line
  // (we cannot tell from `status` alone at which step rejection occurred,
  // so plotting it at any specific node would be misleading).
  if (status === "rejected") {
    return (
      <span
        className={cn(REJECTED_CLASS, className)}
        role="img"
        aria-label={`Status: ${STATUS_LABELS.rejected}`}
      >
        <span aria-hidden="true">✕</span>
        {STATUS_LABELS.rejected}
      </span>
    );
  }

  const currentIdx = SUCCESS_PATH.indexOf(status);

  return (
    <div
      className={cn("flex items-center gap-2", className)}
      role="img"
      aria-label={`Status: ${STATUS_LABELS[status]}`}
    >
      <ol className="flex items-center">
        {SUCCESS_PATH.map((step, idx) => {
          const nodeState: NodeState =
            idx < currentIdx
              ? "done"
              : idx === currentIdx
                ? "active"
                : "future";

          return (
            <li key={step} className="flex items-center">
              <span
                className={cn(
                  NODE_BASE,
                  nodeState === "done" && NODE_DONE,
                  nodeState === "active" && NODE_ACTIVE,
                  nodeState === "future" && NODE_FUTURE,
                )}
                aria-hidden="true"
              >
                {nodeState === "done" ? "✓" : STEP_ICON[step]}
              </span>
              {idx < SUCCESS_PATH.length - 1 && (
                <span
                  className={cn(
                    CONNECTOR_BASE,
                    // Connector AFTER this node is "done" only once we have
                    // moved past this node (idx < currentIdx).
                    idx < currentIdx ? CONNECTOR_DONE : CONNECTOR_FUTURE,
                  )}
                  aria-hidden="true"
                />
              )}
            </li>
          );
        })}
      </ol>
      <span className={LABEL_CLASS}>{STATUS_LABELS[status]}</span>
    </div>
  );
}
