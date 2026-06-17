'use client';

// Button — the single action primitive used by every Stocksie panel.
//
// Three concerns baked in:
//   1. Variant system (primary / secondary / danger / ghost) so the visual
//      hierarchy of "submit", "secondary action", "destructive", and
//      "low-emphasis" is consistent across the 14 instruction forms.
//   2. Loading state — disables interaction and swaps the label for a spinner
//      + the label, so a pending transaction is visually obvious without the
//      caller juggling separate `disabled` / `children` props.
//   3. Default `type="button"` to avoid the classic "Enter in a text field
//      accidentally submits the form" footgun (only the panel-level submit
//      buttons opt into `type="submit"`).
//
// Styling is Tailwind-only and each variant owns a disjoint namespace (bg /
// border / text / hover) so the `cn()` joiner has no merge conflicts to resolve.

import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. `primary` is the main submit; `secondary` is a co-equal
   * alternative; `danger` marks destructive / irreversible actions (close,
   * remove, reject); `ghost` is a low-emphasis tertiary control. */
  variant?: ButtonVariant;
  /** Size. `sm` fits inside dense table rows / compact toolbars; `md` is the
   * default form-button size. */
  size?: ButtonSize;
  /** When `true`, the button is disabled and shows a spinner + its label. Use
   * this to signal a pending transaction while `await program.methods.*.rpc()`
   * resolves. */
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-emerald-500 text-slate-950 hover:bg-emerald-400 focus-visible:outline-emerald-400 disabled:bg-emerald-500/40 disabled:text-slate-950/50',
  secondary:
    'border border-slate-700 bg-slate-800 text-slate-100 hover:bg-slate-700 focus-visible:outline-slate-500 disabled:opacity-50',
  danger:
    'border border-rose-800 bg-rose-950/60 text-rose-200 hover:bg-rose-900/70 focus-visible:outline-rose-500 disabled:opacity-50',
  ghost:
    'bg-transparent text-slate-300 hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-slate-500 disabled:opacity-50',
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
};

/**
 * A themed HTML `<button>` with a built-in loading state.
 *
 * Forwards `ref` so panels can imperatively focus / disable the submit button
 * (e.g. auto-focusing the primary action after a wallet connects).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, disabled, className, children, type = 'button', ...rest },
  ref,
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-colors',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
        'disabled:cursor-not-allowed',
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
});

/** Inline SVG spinner — 1em square so it scales with the button's font size. */
function Spinner() {
  return (
    <svg
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
