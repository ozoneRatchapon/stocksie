// Panel — the card primitive that wraps every Stocksie instruction group.
//
// A consistent surface for the 5 domain panels (Household / Funds / Purchase /
// Reimburse / Rewards): an optional header with title + description + a
// right-aligned actions slot, then an open content area. Keeps the visual
// rhythm uniform so the user can scan the page as a stack of equal-weight
// sections even though each panel owns a very different number of forms.
//
// Pure presentational — no client-only imports, no state. Pulled into the
// client graph by its `'use client'` panel parents and rendered there.

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type PanelProps = {
  /** Section heading. Rendered in a semibold, slightly larger style. */
  title: string;
  /** Optional one-line description shown under the title in muted text. Sets
   * context for the forms below (e.g. "Owner-only membership controls"). */
  description?: ReactNode;
  /** Optional right-aligned slot for a primary action (e.g. a refresh button
   * or a "new request" affordance). */
  actions?: ReactNode;
  /** Optional small label/badge rendered next to the title (e.g. an authority
   * tier pill like "Owner only"). */
  badge?: ReactNode;
  /** Panel body. Typically a stack of `<form>`s or sub-sections. */
  children: ReactNode;
  /** Extra classes on the outer `<section>`. */
  className?: string;
  /** Extra classes on the body wrapper. Use to tune spacing when a panel
   * embeds a dense table or a non-form layout. */
  bodyClassName?: string;
  /** Optional id, useful for anchor navigation from the page-level nav. */
  id?: string;
};

/**
 * A titled card surface for a Stocksie panel.
 *
 * Layout: a rounded, bordered `<section>` with a divided header (title +
 * optional description + optional badge on the left, optional actions on the
 * right) and a padded body. The header is only rendered when at least one of
 * `description`, `actions`, or `badge` is present; a title-only panel still
 * shows the header so the section is always identifiable.
 */
export function Panel({
  title,
  description,
  actions,
  badge,
  children,
  className,
  bodyClassName,
  id,
}: PanelProps) {
  const showHeader = Boolean(description || actions || badge || title);
  return (
    <section
      id={id}
      className={cn(
        "overflow-hidden rounded-xl border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-900/40",
        "shadow-lg shadow-stone-900/5 dark:shadow-slate-950/20",
        className
      )}
    >
      {showHeader && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 dark:border-slate-800 px-5 py-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold tracking-tight text-stone-800 dark:text-slate-100">
                {title}
              </h2>
              {badge}
            </div>
            {description && (
              <p className="max-w-prose text-xs leading-relaxed text-stone-500 dark:text-slate-400">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      <div className={cn("flex flex-col gap-4 p-5", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/**
 * A labeled sub-section inside a {@link Panel}. Used to group a single
 * instruction's form (label + description + the form fields) when a panel
 * hosts more than one instruction. Renders as a subtle bordered block so the
 * panel body reads as a clear vertical list of independent actions.
 */
export type SubPanelProps = {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function SubPanel({ label, hint, children, className }: SubPanelProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-stone-200 dark:border-slate-800/80 bg-stone-50/60 dark:bg-slate-950/40 p-4",
        "flex flex-col gap-3",
        className
      )}
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-600 dark:text-slate-300">
          {label}
        </h3>
        {hint && (
          <p className="text-xs leading-relaxed text-stone-500 dark:text-slate-500">
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
