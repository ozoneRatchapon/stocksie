"use client";

// /shelf route — the off-chain household essentials catalog.
//
// Plan 006 Phase B (B.3). This is the web2-friendly front door to the shelf:
// browse, add, edit, and delete the household's recurring essentials on this
// device. Camera scanning comes later (Phase C); for now every entry is typed
// by hand, so the shelf is fully usable on a desktop with no special hardware.
//
// Importantly, the shelf is **strictly off-chain** (plan 006 §2, §3;
// docs/PRIVACY.md). It lives in IndexedDB on this device only. Item names and
// prices never go on-chain — only their blake3 hashes do, and only when a
// purchase request that references them is submitted. So this route does NOT
// require a connected wallet: you can catalog your household essentials before
// you ever sign in, then connect when you're ready to actually spend.
//
// Layout mirrors the Dashboard shell (centered 6xl column, slate theme) but
// lighter — a header with a back-to-dashboard link, the Stocksie wordmark, and
// the wallet button (so you can connect from here too), then the ShelfList,
// then a short privacy footer that sets honest expectations.

import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";
import { ShelfList } from "@/components/shelf/ShelfList";

export default function ShelfPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      {/* ----------------------------------------------------------------- */}
      {/* Header — back link, wordmark, wallet control                      */}
      {/* ----------------------------------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Link
            href="/"
            className="inline-flex w-fit items-center gap-1 text-xs font-medium text-slate-400 transition-colors hover:text-slate-200"
          >
            <span aria-hidden="true">←</span> Back to dashboard
          </Link>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-slate-100">
            <span aria-hidden="true">📦</span>
            Shelf
          </h1>
          <p className="text-sm text-slate-400">
            Your household essentials, saved on this device.{" "}
            <Link
              href="/scan"
              className="font-medium text-emerald-400 transition-colors hover:text-emerald-300"
            >
              Or scan a barcode →
            </Link>
          </p>
        </div>
        <WalletButton />
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* The shelf — list + onboarding form (no camera yet)                */}
      {/* ----------------------------------------------------------------- */}
      <div className="mt-8">
        <ShelfList />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Privacy footer — honest about where the data lives                */}
      {/* ----------------------------------------------------------------- */}
      <footer className="mt-10 border-t border-slate-800 pt-5 text-xs leading-relaxed text-slate-500">
        <p>
          The shelf lives in this browser only (IndexedDB). Names and prices
          never go on-chain — when you spend, only a hash of the price is
          recorded on Solana, so the chain can prove the amount without ever
          reading it.
        </p>
      </footer>
    </main>
  );
}
