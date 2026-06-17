"use client";

// Stocksie main page — the friendly web2-style UI shell.
//
// Composes three regions into a single scrollable layout:
//
//   1. Header        — friendly welcome line, a one-line status pill, and the
//                      sign-in control. No developer metadata up here.
//   2. Live state    — the StateView (shared budget, member roster, shopping
//                      requests) plus the household-admin address field that
//                      drives household resolution for the whole page.
//   3. Action panels — the five domain panels (Household / Money / Shopping /
//                      Pay back / Rewards) covering all 14 actions.
//
// Developer-only surfaces (cluster, program client, wallet adapter name) are
// tucked behind a collapsed <details> at the very bottom so they never
// dominate the first screen for non-crypto users.
//
// No state lives here. The household resolution flows through
// `HouseholdContextProvider` (wired in `Providers.tsx`), the post-write
// refresh signal through `RefreshProvider`, and the wallet through
// `WalletProvider`. This keeps the page a pure layout surface that is easy
// to scan and reorder.

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useProgram } from "@/lib/program";
import { StateView } from "@/components/StateView";
import { HouseholdPanel } from "@/components/panels/HouseholdPanel";
import { FundsPanel } from "@/components/panels/FundsPanel";
import { PurchasePanel } from "@/components/panels/PurchasePanel";
import { ReimbursePanel } from "@/components/panels/ReimbursePanel";
import { RewardsPanel } from "@/components/panels/RewardsPanel";

export default function Home() {
  const { connection } = useConnection();
  const { connected, publicKey, wallet } = useWallet();
  const program = useProgram();

  const endpoint = connection.rpcEndpoint;
  const shortAddr =
    publicKey && connected
      ? `${publicKey.toBase58().slice(0, 6)}…${publicKey.toBase58().slice(-4)}`
      : null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      {/* ----------------------------------------------------------------- */}
      {/* Header — friendly welcome, status pill, sign-in control           */}
      {/* ----------------------------------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-100">
            <span aria-hidden="true">🏠</span>
            Stocksie
          </h1>
          <p className="text-sm text-slate-400">
            Shop together, stay on budget, earn rewards.
          </p>
        </div>
        <WalletMultiButton />
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* One-line status pill — replaces the old 3-card dev header.        */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-4">
        {connected && shortAddr ? (
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
            <span
              className="h-1.5 w-1.5 rounded-full bg-emerald-400"
              aria-hidden="true"
            />
            <span className="font-medium">Signed in</span>
            <span className="text-emerald-400/60">·</span>
            <code className="font-mono text-[11px] text-emerald-200/80">
              {shortAddr}
            </code>
          </div>
        ) : (
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/40 px-3 py-1 text-xs text-slate-400">
            <span
              className="h-1.5 w-1.5 rounded-full bg-slate-500"
              aria-hidden="true"
            />
            <span>Not signed in — sign in to start</span>
          </div>
        )}
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Live state — admin field + shared budget + roster + ledger        */}
      {/* ----------------------------------------------------------------- */}
      <div className="mt-8">
        <StateView />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Action panels (all 14 actions)                                    */}
      {/* ----------------------------------------------------------------- */}
      <div className="mt-8 grid gap-6">
        <HouseholdPanel />
        <FundsPanel />
        <PurchasePanel />
        <ReimbursePanel />
        <RewardsPanel />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Footer hint                                                       */}
      {/* ----------------------------------------------------------------- */}
      <footer className="mt-10 border-t border-slate-800 pt-5 text-xs text-slate-500">
        {connected && shortAddr ? (
          <p>
            You are signed in as{" "}
            <code className="font-mono text-emerald-400">{shortAddr}</code>.
            Every action you take is approved by this account and recorded
            against the household shown above.
          </p>
        ) : (
          <p>
            Sign in with Phantom, Solflare, or Backpack — or use the built-in
            dev account to try Stocksie on the local cluster.
          </p>
        )}
      </footer>

      {/* ----------------------------------------------------------------- */}
      {/* Developer details — collapsed by default. Tucked at the bottom so */}
      {/* non-crypto users never see it unless they go looking.             */}
      {/* ----------------------------------------------------------------- */}
      <details className="mt-6 rounded-lg border border-slate-800/70 bg-slate-900/30 text-xs text-slate-500">
        <summary className="cursor-pointer select-none px-4 py-3 font-medium text-slate-400 hover:text-slate-300">
          Developer details
        </summary>
        <div className="grid gap-3 px-4 pb-4 sm:grid-cols-3">
          <DevInfoCard label="Cluster" value={endpointLabel(endpoint)} />
          <DevInfoCard
            label="Program client"
            value={program ? "loaded" : connected ? "loading…" : "—"}
          />
          <DevInfoCard
            label="Wallet adapter"
            value={wallet?.adapter.name ?? (connected ? "connected" : "none")}
          />
        </div>
      </details>
    </main>
  );
}

/** Render the RPC endpoint as a friendly cluster label when it is the localnet. */
function endpointLabel(endpoint: string): string {
  return endpoint.includes("127.0.0.1") || endpoint.includes("localhost")
    ? "localnet (Surfpool)"
    : endpoint;
}

/** Small labeled value card used in the Developer details section. */
function DevInfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-[10px] uppercase tracking-wide text-slate-600">
        {label}
      </div>
      <div
        className="mt-1 truncate text-sm font-medium text-slate-300"
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
