"use client";

// Stocksie main page — the reference UI shell.
//
// Composes the three pillars of the frontend into a single scrollable layout:
//
//   1. Header        — title, cluster / program / wallet info, connect button.
//   2. Live State    — the StateView (vault balance, member roster, purchase
//                       ledger) plus the household-owner address field that
//                       drives household-PDA resolution for the whole page.
//   3. Instruction
//      panels       — the five domain panels (Household / Funds / Purchase /
//                       Reimburse / Rewards) covering all 14 instructions.
//
// No state lives here. The household resolution flows through
// `HouseholdContextProvider` (wired in `Providers.tsx`), the post-write refresh
// signal through `RefreshProvider`, and the wallet through `WalletProvider`.
// This keeps the page a pure layout surface that is easy to scan and reorder.

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

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      {/* ----------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ----------------------------------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Stocksie
          </h1>
          <p className="text-sm text-slate-400">
            Household coordination on Solana — vault, purchase lifecycle,
            rewards.
          </p>
        </div>
        <WalletMultiButton />
      </header>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <InfoCard label="Cluster" value={endpointLabel(endpoint)} />
        <InfoCard
          label="Program client"
          value={program ? "loaded" : connected ? "loading…" : "—"}
        />
        <InfoCard
          label="Wallet"
          value={wallet?.adapter.name ?? (connected ? "connected" : "none")}
        />
      </section>

      {/* ----------------------------------------------------------------- */}
      {/* Live state — owner field + vault + roster + ledger                */}
      {/* ----------------------------------------------------------------- */}
      <div className="mt-8">
        <StateView />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Instruction panels (all 14 instructions)                          */}
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
        {connected ? (
          <p>
            Connected as{" "}
            <code className="font-mono text-emerald-400">
              {publicKey?.toBase58()}
            </code>
            . All transactions sign through this wallet; the resolved household
            is shown in the Live State panel above.
          </p>
        ) : (
          <p>
            Connect a wallet — Phantom / Solflare (Wallet Standard) or the
            built-in <strong>Local Keypair (dev)</strong> — to drive the
            Stocksie program against the Surfpool local cluster.
          </p>
        )}
      </footer>
    </main>
  );
}

/** Render the RPC endpoint as a friendly cluster label when it is the localnet. */
function endpointLabel(endpoint: string): string {
  return endpoint.includes("127.0.0.1") || endpoint.includes("localhost")
    ? "localnet (Surfpool)"
    : endpoint;
}

/** Small labeled value card used in the header info row. */
function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div
        className="mt-1 truncate text-sm font-medium text-slate-200"
        title={value}
      >
        {value}
      </div>
    </div>
  );
}
