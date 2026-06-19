"use client";

// WalletButton — the Stocksie "sign in" control, fully re-skinned for the
// web2-friendly palette (plan 007 §F.1 / plan 005 §5.7).
//
// Two states:
//   - Disconnected: a primary "Sign in" button that opens the wallet-picker
//     modal (Wallet Standard wallets + the built-in dev keypair adapter).
//   - Connected: a soft pill showing the deterministic avatar (color + initials
//     derived from the connected pubkey) + the wallet adapter's name, with a
//     dropdown menu for Copy address / Switch account / Sign out.
//
// The avatar replaces the wallet-adapter-ui's default truncated-address
// display — web2 users see a face (the avatar) + a friendly name, not a
// glyph-salad pubkey. The full pubkey is still one click away via "Copy
// address".
//
// SSR-safety: same mount-guard pattern as before — `BaseWalletMultiButton`
// relied on Wallet Standard detection (`window.solana`) which only runs in the
// browser, so we gate the whole control on a `mounted` flag and render `null`
// until the client's first effect. The landing's sign-in CTA opens the same
// modal via `useWalletModal()`, so the two stay consistent.

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Avatar } from "@/components/ui/Avatar";

export function WalletButton() {
  const { connected, publicKey, wallet, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const [mounted, setMounted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  // Close the dropdown on any outside click or Escape. Standard menu behaviour.
  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Mount guard: render nothing during SSR + pre-mount so the header layout is
  // stable and we avoid the wallet-standard hydration mismatch.
  if (!mounted) return null;

  // Disconnected: primary "Sign in" button → opens the wallet picker modal.
  if (!connected || !publicKey) {
    return (
      <button
        type="button"
        onClick={() => setVisible(true)}
        className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-medium text-stone-50 transition-colors hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:text-slate-950"
      >
        <span aria-hidden="true">🔑</span>
        Sign in
      </button>
    );
  }

  // Connected: avatar + adapter name pill with a dropdown menu.
  const addr = publicKey.toBase58();
  const adapterName = wallet?.adapter.name ?? "Wallet";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context, permissions) — the
      // menu still closes so the user isn't left wondering.
    }
    setMenuOpen(false);
  };

  const handleSwitch = () => {
    setMenuOpen(false);
    setVisible(true);
  };

  const handleSignOut = () => {
    setMenuOpen(false);
    disconnect();
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        className="inline-flex h-10 items-center gap-2 rounded-lg border border-stone-200 bg-white px-2 pr-3 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
      >
        <Avatar seed={addr} size="sm" />
        <span className="max-w-[10ch] truncate">{adapterName}</span>
        <svg
          className="h-4 w-4 text-stone-400 dark:text-slate-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-lg border border-stone-200 bg-white py-1 shadow-lg shadow-stone-900/10 dark:border-slate-700 dark:bg-slate-800 dark:shadow-slate-950/40"
        >
          <MenuItem onClick={handleCopy}>
            {copied ? "✓ Copied" : "Copy address"}
          </MenuItem>
          <MenuItem onClick={handleSwitch}>Switch account</MenuItem>
          <MenuItem onClick={handleSignOut} danger>
            Sign out
          </MenuItem>
        </div>
      )}
    </div>
  );
}

/** A single row in the connected-state dropdown menu. */
function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-stone-100 dark:hover:bg-slate-700 ${
        danger
          ? "text-rose-600 dark:text-rose-300"
          : "text-stone-700 dark:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}
