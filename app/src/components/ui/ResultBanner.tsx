'use client';

// ResultBanner — the single feedback surface used by every Stocksie panel.
//
// One component, four states, rendered as a colored callout immediately under
// the action that produced it:
//
//   - `pending`  → amber, with a spinner and "Signing and sending…" copy
//   - `signature`→ emerald, with the confirmed tx signature in mono, an
//                  explorer link (cluster-aware), and a copy button
//   - `error`    → rose, with the extracted error message (callers pass the
//                  already-human-readable string from `extractErrorMessage`)
//   - idle       → nothing rendered at all
//
// The `pending` / `signature` / `error` trio is deliberately modeled as three
// independent props rather than a single `status` union: a panel's submit
// handler typically tracks them as three separate pieces of state (via the
// `useTransaction` hook), and matching props to that shape keeps the wiring
// trivial — no normalization layer between the hook and the UI.
//
// Cluster awareness: the explorer link is built from the active RPC endpoint
// via `useConnection()`. Surfpool localnet is encoded as a Solana Explorer
// `cluster=custom&customUrl=…` link, which works when the validator is
// reachable from the browser; on a true offline local cluster the link simply
// won't resolve but the signature is still copyable.

import { useState } from 'react';
import type { MouseEvent } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { cn } from '@/lib/cn';

export type ResultBannerProps = {
  /** Awaiting wallet signature + RPC confirmation. Renders the pending state
   * and takes precedence over `signature`/`error`. */
  pending?: boolean;
  /** Most recently confirmed transaction signature. Renders the success state
   * unless `pending` is true or `error` is set. */
  signature?: string | null;
  /** Human-readable error message (pass the output of `extractErrorMessage`).
   * Renders the error state and takes precedence over `signature`. */
  error?: string | null;
  /** When provided, a dismiss (×) button is rendered that invokes this. The
   * caller is responsible for clearing whichever prop(s) it wants — typically
   * `error` and/or `signature`. */
  onDismiss?: () => void;
  /** Optional className applied to the outer callout for layout tweaks. */
  className?: string;
};

const COPY_TIMEOUT_MS = 1200;

export function ResultBanner({
  pending,
  signature,
  error,
  onDismiss,
  className,
}: ResultBannerProps) {
  const { connection } = useConnection();
  const [copied, setCopied] = useState(false);

  // Idle: render nothing so the panel layout doesn't reserve empty space.
  if (!pending && !signature && !error) return null;

  const isError = Boolean(error) && !pending;
  const isSuccess = !isError && !pending && Boolean(signature);
  const isPending = Boolean(pending);

  const handleCopy = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!signature) return;
    try {
      await navigator.clipboard.writeText(signature);
      setCopied(true);
      window.setTimeout(() => setCopied(false), COPY_TIMEOUT_MS);
    } catch {
      // `navigator.clipboard` can be unavailable in insecure contexts or older
      // browsers; silently no-op rather than derailing the click. The
      // signature is still selectable + copyable via the explorer link.
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mt-3 flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm',
        isPending && 'border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-200',
        isSuccess && 'border-emerald-500/40 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-200',
        isError && 'border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-200',
        className,
      )}
    >
      <span className="mt-0.5 flex-shrink-0">
        {isPending && <Spinner />}
        {isSuccess && <CheckIcon />}
        {isError && <AlertIcon />}
      </span>

      <div className="min-w-0 flex-1">
        {isPending && (
          <p className="font-medium">Sending…</p>
        )}

        {isSuccess && signature && (
          <div className="flex flex-col gap-1">
            <p className="font-medium">Done</p>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide text-emerald-600/70 dark:text-emerald-400/70">
                Receipt ID
              </span>
              <code className="truncate font-mono text-xs text-emerald-600/90 dark:text-emerald-300/90">
                {signature}
              </code>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <a
                href={explorerTxUrl(connection.rpcEndpoint, signature)}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-emerald-600 dark:text-emerald-300 underline-offset-2 hover:underline"
              >
                View receipt ↗
              </a>
              <button
                type="button"
                onClick={handleCopy}
                className="font-medium text-emerald-600/80 dark:text-emerald-300/80 underline-offset-2 hover:text-emerald-700 dark:hover:text-emerald-200 hover:underline"
              >
                {copied ? 'Copied' : 'Copy receipt ID'}
              </button>
            </div>
          </div>
        )}

        {isError && (
          <div className="flex flex-col gap-0.5">
            <p className="font-medium">Couldn't complete</p>
            <p className="break-words text-xs text-rose-700/90 dark:text-rose-200/90">{error}</p>
          </div>
        )}
      </div>

      {onDismiss && !isPending && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 flex-shrink-0 rounded p-1 text-current/70 transition hover:bg-white/10 hover:text-current"
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer URL — cluster-aware
// ---------------------------------------------------------------------------

/**
 * Build a Solana Explorer URL for a transaction signature, picking the
 * `cluster` query param from the active RPC endpoint.
 *
 *   - Surfpool / localhost → `cluster=custom&customUrl=<encoded endpoint>` so
 *     Explorer talks to the local validator directly.
 *   - `api.devnet.solana.com` → `cluster=devnet`.
 *   - anything else (incl. mainnet-beta) → mainnet (no cluster param).
 *
 * Pure / SSR-safe: takes the endpoint string rather than calling
 * `useConnection()` itself, so it is unit-testable and reusable from
 * non-React contexts (e.g. a toast helper).
 */
export function explorerTxUrl(rpcEndpoint: string, signature: string): string {
  const base = `https://explorer.solana.com/tx/${signature}`;
  const host = tryParseHost(rpcEndpoint);
  if (!host) return base;
  if (host === '127.0.0.1' || host === 'localhost' || host.endsWith('.localhost')) {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(rpcEndpoint)}`;
  }
  if (host.includes('devnet')) return `${base}?cluster=devnet`;
  if (host.includes('testnet')) return `${base}?cluster=testnet`;
  return base;
}

function tryParseHost(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Inline icons (1em square, currentColor)
// ---------------------------------------------------------------------------

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M16.704 5.296a1 1 0 0 1 0 1.408l-7.5 7.5a1 1 0 0 1-1.408 0l-3.5-3.5a1 1 0 1 1 1.408-1.408L8.5 12.092l6.796-6.796a1 1 0 0 1 1.408 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M8.485 3.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 3.495zM10 7a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 7zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22z" />
    </svg>
  );
}
