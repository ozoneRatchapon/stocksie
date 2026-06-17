'use client';

// Stocksie entry route — a thin router between orientation and the app.
//
// The whole UX hinges on one signal: is a wallet connected?
//   - **No**  → show `<Landing />`, the read-only front door (hero, hook,
//               example scenario, "Get started" CTA). This is what a brand-new
//               web2 user sees, so they understand what Stocksie is *before*
//               being asked to sign in or fill anything in.
//   - **Yes** → show `<Dashboard />`, the operational UI (live state + the
//               five domain panels covering all 14 actions).
//
// Keeping this as one route (`/`) with conditional rendering matches web2
// expectations — "the app knows I'm new" — and avoids a separate marketing
// URL. No state lives here; the connection signal comes from `useWallet()`
// (wired through `WalletProvider` in `Providers.tsx`).

import { useWallet } from "@solana/wallet-adapter-react";
import { Landing } from "@/components/Landing";
import { Dashboard } from "@/components/Dashboard";

export default function Home() {
  const { connected } = useWallet();
  return connected ? <Dashboard /> : <Landing />;
}
