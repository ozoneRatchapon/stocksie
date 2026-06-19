"use client";

// Modal — a lightweight, accessible overlay primitive.
//
// A fixed-position backdrop + centered panel with the basics every modal needs:
// ESC to close, click-on-backdrop to close, a close (×) affordance, and the
// right ARIA (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`). Body
// scroll is locked while open so a long modal doesn't double-scroll the page.
//
// Deliberately NOT a portal: the Stocksie app is a single-rooted client tree,
// and rendering the overlay inline (with a high z-index fixed layer) avoids a
// `createPortal` dependency and keeps focus order predictable. The backdrop is
// a sibling of the panel inside the same fixed container.
//
// Used by the BestValueModal (plan 006 Phase D); kept generic so future
// confirmations / detail views can reuse it.

import { useEffect, useId, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type ModalProps = {
  /** Whether the modal is visible. When `false`, nothing is rendered. */
  open: boolean;
  /** Title shown in the header. Required for `aria-labelledby`. */
  title: string;
  /** One-line description rendered under the title in muted text. */
  description?: ReactNode;
  /** Modal body. */
  children: ReactNode;
  /** Footer slot, typically action buttons. Right-aligned by default. */
  footer?: ReactNode;
  /** Close handler. Invoked on ESC, backdrop click, and the × button. */
  onClose: () => void;
  /** Extra classes on the panel surface. */
  className?: string;
};

/**
 * Render an overlay modal. Returns `null` when `open` is false.
 *
 * Side effects while open: locks body scroll and listens for ESC. Both are
 * cleaned up on close/unmount.
 */
export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  className,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();

  // ESC to close + body-scroll lock. Both are no-ops when closed (the effect
  // early-returns). The listener is attached to `window` so ESC works even when
  // focus is inside an input inside the modal.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-white dark:bg-slate-950/70 p-4 backdrop-blur-sm sm:items-center"
      // Click on the backdrop (not the panel) closes. The panel stops
      // propagation so clicks inside it don't bubble out.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          "relative my-8 w-full max-w-2xl rounded-xl border border-stone-200 dark:border-slate-800 bg-stone-100 dark:bg-slate-900 shadow-2xl shadow-stone-900/10 dark:shadow-slate-950/50",
          className,
        )}
      >
        {/* Header */}
        <header className="flex items-start justify-between gap-4 border-b border-stone-200 dark:border-slate-800 px-5 py-4">
          <div className="flex flex-col gap-1">
            <h2
              id={titleId}
              className="text-sm font-semibold tracking-tight text-stone-800 dark:text-slate-100"
            >
              {title}
            </h2>
            {description && (
              <p
                id={descId}
                className="max-w-prose text-xs leading-relaxed text-stone-500 dark:text-slate-400"
              >
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 -mt-1 flex-shrink-0 rounded p-1.5 text-stone-500 dark:text-slate-400 transition hover:bg-white dark:hover:bg-slate-800 hover:text-stone-700 dark:hover:text-slate-200"
          >
            <CloseIcon />
          </button>
        </header>

        {/* Body */}
        <div className="px-5 py-4">{children}</div>

        {/* Footer */}
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-stone-200 dark:border-slate-800 px-5 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}
