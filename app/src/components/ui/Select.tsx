// Labeled dropdown primitive for the Stocksie panels.
//
// Visual + API sibling of `Field.tsx`: same label / helpText / error contract,
// same Tailwind palette, same accessible wiring (`useId` for the label ↔
// `<select>` association, `aria-describedby` for the help / error line).
//
// Used wherever an instruction takes a value from a closed set — primarily the
// `Role` enum (`add_member`, `set_role`) and the Status filter on the purchase
// ledger. Options are passed in as `{ value, label }` pairs so the caller keeps
// full control over which variants are offered (e.g. `add_member` deliberately
// omits `owner` because the program rejects `Role::Owner` there).
//
// Pure presentational — no client-only imports, no state. It is pulled into the
// client graph by its `'use client'` panel parents and rendered there.

import { useId, type ReactNode } from 'react';
import type { ChangeEvent } from 'react';
import { cn } from '@/lib/cn';

export type SelectOption = {
  /** The string value emitted to `onChange`. */
  value: string;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** When `true`, the option is rendered but not selectable. Use this to
   * visually advertise a variant the user cannot pick in this context (e.g.
   * `Owner` in the `add_member` role picker, greyed out with an explanatory
   * label). */
  disabled?: boolean;
};

export type SelectProps = {
  /** Stable id; auto-generated when omitted. Drives `<label htmlFor>`. */
  id?: string;
  /** Visible label, always rendered above the select. */
  label: string;
  /** Current value (controlled). Use the empty string to represent "nothing
   * selected" — renders the `placeholder` as a disabled first option. */
  value: string;
  /** Called with the new string value on every change. */
  onChange: (value: string) => void;
  /** Selectable options. The first `{ value, label }` pair with an empty value
   * is treated as the placeholder row. */
  options: readonly SelectOption[];
  /** Placeholder shown as a disabled first row when `value === ''`. */
  placeholder?: string;
  /** Secondary muted help text shown under the select. */
  helpText?: ReactNode;
  /** Error message; turns the border red and renders the message below. */
  error?: string | null;
  /** Marks the field required (adds `*` to the label and `required` on select). */
  required?: boolean;
  /** Disables the select. */
  disabled?: boolean;
  /** Auto-focus on mount. */
  autoFocus?: boolean;
  /** Enter-key passthrough — common for "pick a value and submit" flows. */
  onSubmit?: () => void;
  /** Extra classes on the outer wrapper. */
  className?: string;
};

export function Select({
  id: idProp,
  label,
  value,
  onChange,
  options,
  placeholder,
  helpText,
  error,
  required,
  disabled,
  autoFocus,
  onSubmit,
  className,
}: SelectProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const describedById = `${id}-desc`;
  const hasError = Boolean(error);

  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  // The native `<select>` has no `onSubmit`, but we honor the prop on Enter so
  // the panels can offer a uniform "type/pick then submit" UX across Field and
  // Select. `key === 'Enter'` on a focused `<select>` is reliable across
  // browsers and does not conflict with the click-to-open interaction.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
    if (e.key === 'Enter' && onSubmit) {
      e.preventDefault();
      onSubmit();
    }
  };

  // Show the placeholder as a disabled leading row only when no value is set.
  // Avoids the user accidentally "selecting" the placeholder text on submit.
  const showPlaceholder = Boolean(placeholder) && value === '';

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-slate-400"
      >
        {label}
        {required && <span className="ml-0.5 text-rose-600 dark:text-rose-400">*</span>}
      </label>
      <div className="relative flex items-center">
        <select
          id={id}
          value={value}
          onChange={handleChange}
          onKeyDown={onSubmit ? handleKeyDown : undefined}
          required={required}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-invalid={hasError || undefined}
          aria-describedby={helpText || hasError ? describedById : undefined}
          className={cn(
            'w-full appearance-none rounded-lg border bg-white dark:bg-slate-950/60 px-3 py-2 text-sm text-stone-800 dark:text-slate-100 outline-none transition',
            'focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            // Right padding leaves room for the chevron adornment.
            'pr-9',
            hasError ? 'border-rose-500/70' : 'border-stone-200 dark:border-slate-800',
          )}
        >
          {showPlaceholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        {/* Chevron adornment — a single SVG kept inline so the primitive stays
            self-contained (no icon-library dependency). `pointer-events-none`
            so clicks fall through to the native `<select>` toggle. */}
        <svg
          className="pointer-events-none absolute right-3 h-4 w-4 text-stone-500 dark:text-slate-500"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 8l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      {(helpText || hasError) && (
        <p
          id={describedById}
          className={cn('text-xs', hasError ? 'text-rose-600 dark:text-rose-400' : 'text-stone-500 dark:text-slate-500')}
        >
          {hasError ? error : helpText}
        </p>
      )}
    </div>
  );
}
