// Labeled input primitive for the Stocksie panels.
//
// A controlled, accessible text-or-number field with a label, optional help
// text, optional inline error, and an optional trailing unit suffix
// (e.g. `SOL`). Designed to cover every form input the 14 instructions need:
// pubkey / hash strings (`mono`), SOL amounts (`type="number"` + `suffix="SOL"`),
// request ids, reward points, and free-text item/reason descriptions that get
// blake3-hashed client-side before submission.
//
// Pure presentational — no client-only imports, no state. It is pulled into the
// client graph by its `'use client'` panel parents and rendered there.

import { useId } from "react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { cn } from "@/lib/cn";

export type FieldProps = {
  /** Stable id; auto-generated when omitted. Drives `<label htmlFor>`. */
  id?: string;
  /** Visible label, always rendered above the input. */
  label: string;
  /** Current value (controlled). */
  value: string;
  /** Called with the new string value on every keystroke. */
  onChange: (value: string) => void;
  /** Standard input `type` — defaults to `text`. */
  type?: "text" | "number" | "password" | "email" | "url" | "search" | "tel";
  /** Placeholder shown when the value is empty. */
  placeholder?: string;
  /** Secondary muted help text shown under the input. */
  helpText?: ReactNode;
  /** Error message; turns the border red and renders the message below. */
  error?: string | null;
  /** Marks the field required (adds `*` to the label and `required` on input). */
  required?: boolean;
  /** Disables the input. */
  disabled?: boolean;
  /** Read-only (value shown but not editable). */
  readOnly?: boolean;
  /** Auto-focus on mount. */
  autoFocus?: boolean;
  /** Render in monospace (pubkeys, hashes, signatures). */
  mono?: boolean;
  /** `min` for `type="number"`. */
  min?: number | string;
  /** `max` for `type="number"`. */
  max?: number | string;
  /** `step` for `type="number"` (e.g. `"0.0001"` for SOL). */
  step?: number | string;
  /** Auto-complete tokens passed through to the underlying `<input>`. */
  autoComplete?: string;
  /** Enter-key handler — common for "type a value and submit" fields. */
  onSubmit?: () => void;
  /** Optional trailing adornment rendered inside the input (e.g. `SOL`). */
  suffix?: ReactNode;
  /** Extra classes on the outer wrapper. */
  className?: string;
};

export function Field({
  id: idProp,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  helpText,
  error,
  required,
  disabled,
  readOnly,
  autoFocus,
  mono,
  min,
  max,
  step,
  autoComplete,
  onSubmit,
  suffix,
  className,
}: FieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const describedById = `${id}-desc`;
  const hasError = Boolean(error);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && onSubmit) {
      // Prevent native form submission: every panel wires its own submit via
      // the explicit onSubmit prop rather than a wrapping <form>.
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wide text-stone-500 dark:text-slate-400"
      >
        {label}
        {required && <span className="ml-0.5 text-rose-600 dark:text-rose-400">*</span>}
      </label>
      <div className="relative flex items-center">
        <input
          id={id}
          type={type}
          value={value}
          onChange={handleChange}
          onKeyDown={onSubmit ? handleKeyDown : undefined}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          min={min}
          max={max}
          step={step}
          autoComplete={autoComplete}
          spellCheck={false}
          aria-invalid={hasError || undefined}
          aria-describedby={helpText || hasError ? describedById : undefined}
          className={cn(
            "w-full rounded-lg border bg-white dark:bg-slate-950/60 px-3 py-2 text-sm text-stone-800 dark:text-slate-100 outline-none transition",
            "placeholder:text-stone-400 dark:placeholder:text-slate-600",
            "focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "read-only:cursor-default",
            mono && "font-mono text-xs tracking-tight",
            hasError ? "border-rose-500/70" : "border-stone-200 dark:border-slate-800",
            suffix && "pr-12"
          )}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 text-xs font-medium text-stone-500 dark:text-slate-500">
            {suffix}
          </span>
        )}
      </div>
      {(helpText || hasError) && (
        <p
          id={describedById}
          className={cn(
            "text-xs",
            hasError ? "text-rose-600 dark:text-rose-400" : "text-stone-500 dark:text-slate-500"
          )}
        >
          {hasError ? error : helpText}
        </p>
      )}
    </div>
  );
}
