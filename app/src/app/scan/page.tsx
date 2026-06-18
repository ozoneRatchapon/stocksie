"use client";

// /scan route — barcode scanner front door (plan 006, Phase C).
//
// The camera scanner is the LAST feature in plan 006's sequence on purpose:
// the product is fully usable without it (every product can be added by hand
// on /shelf, every field can be typed by hand on /scan). The scanner is a
// convenience for users with a phone or webcam.
//
// This page is a Client Component because `next/dynamic({ ssr: false })` is
// only callable from a client context. The `ssr: false` is load-bearing:
// `html5-qrcode` touches `navigator.mediaDevices` and friends, which don't
// exist on the server. With it, the scanner dep is split into a lazy chunk
// that only loads when `/scan` is actually visited — keeping the `/` and
// `/shelf` First Load bundles flat (plan 006 §7).
//
// Layout mirrors /shelf: header with back-to-dashboard link, the Stocksie
// wordmark, and the wallet button (so you can connect from here too, even
// though scanning itself is off-chain and needs no wallet). The body is the
// lazy `ScanClient`; the privacy footer matches /shelf's so the off-chain
// boundary is restated honestly everywhere the shelf data shows up.

import dynamic from "next/dynamic";
import Link from "next/link";
import { WalletButton } from "@/components/WalletButton";

// Lazy-load the scanner body. `ssr: false` keeps `html5-qrcode` (and its
// transitive browser-API dependencies) off the server graph entirely.
const ScanClient = dynamic(
  () => import("@/components/scan/ScanClient").then((m) => m.ScanClient),
  {
    ssr: false,
    loading: () => <ScanSkeleton />,
  },
);

export default function ScanPage() {
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
            <span aria-hidden="true">📷</span>
            Scan
          </h1>
          <p className="text-sm text-slate-400">
            Scan a barcode to find a product on your shelf — or add it on the
            spot.
          </p>
        </div>
        <WalletButton />
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* The scanner — lazy, client-only                                   */}
      {/* ----------------------------------------------------------------- */}
      <div className="mt-8">
        <ScanClient />
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Privacy footer — honest about where the data lives                */}
      {/* ----------------------------------------------------------------- */}
      <footer className="mt-10 border-t border-slate-800 pt-5 text-xs leading-relaxed text-slate-500">
        <p>
          Scanning and lookup happen on this device only (IndexedDB). The
          camera stream never leaves your browser, and names, barcodes, and
          prices never go on-chain — when you spend, only a hash of the price
          is recorded on Solana, so the chain can prove the amount without
          ever reading it.
        </p>
      </footer>
    </main>
  );
}

/** First-paint placeholder shown while the scanner chunk loads. */
function ScanSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-950/30 p-6">
      <div className="h-4 w-32 animate-pulse rounded bg-slate-800/70" />
      <div className="h-10 w-40 animate-pulse rounded bg-slate-800/70" />
      <div className="mt-2 h-px w-full bg-slate-800/50" />
      <div className="h-4 w-24 animate-pulse rounded bg-slate-800/70" />
      <div className="h-10 w-full animate-pulse rounded bg-slate-800/70" />
    </div>
  );
}
