"use client";

// Landing — the Stocksie "front door" for first-time web2 users.
//
// Shown by `page.tsx` whenever no wallet is connected. A new user lands here
// instead of in a wall of forms, so they can understand what Stocksie is,
// what problem it solves, and what a successful session looks like — *before*
// being asked to sign in or fill anything in.
//
// Four sections, in reading order:
//   1. Hero       — one-line value prop + the primary "Get started" CTA.
//   2. Hook       — three "what Stocksie helps with" cards, mapped to the
//                   product's true headline: supply tracking, family sharing,
//                   and smart buying (the comparison engine is on the roadmap).
//   3. Example    — a concrete worked scenario (the Lee household) that turns
//                   the abstract product into something tangible.
//   4. Final CTA  — a second entry point for users who scrolled to the bottom.
//
// Read-only marketing surface. The only interaction is "Get started →", which
// opens the wallet picker modal via `useWalletModal`. Once a wallet connects,
// `page.tsx` swaps this out for the operational dashboard. No state, no
// networking, no on-chain calls.

import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { WalletButton } from "@/components/WalletButton";

export function Landing() {
  const { setVisible } = useWalletModal();

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      {/* --------------------------------------------------------------- */}
      {/* Minimal header — logo + always-available sign-in affordance      */}
      {/* --------------------------------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-xl font-semibold tracking-tight text-slate-100">
          <span aria-hidden="true">🏠</span>
          Stocksie
        </div>
        <WalletButton />
      </header>

      {/* --------------------------------------------------------------- */}
      {/* Hero                                                            */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-16 text-center">
        <h1 className="mx-auto max-w-3xl text-balance text-4xl font-bold tracking-tight text-slate-50 sm:text-5xl">
          Never run out —{" "}
          <span className="text-emerald-400">and never double-buy</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-slate-400">
          Your family&rsquo;s shared list for household essentials. Everyone
          knows what&rsquo;s running low, what&rsquo;s already bought, and what
          to grab next.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="rounded-xl bg-emerald-500 px-7 py-3 text-base font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
          >
            Get started &rarr;
          </button>
          <p className="text-xs text-slate-500">
            Sign in with Phantom, Solflare, Backpack — or the built-in dev
            account to try it locally.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Hook — three "what it helps with" cards                          */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-20">
        <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-slate-500">
          What Stocksie helps with
        </h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          <HookCard
            icon="🛒"
            title="Never run out"
            body="Spot what&rsquo;s running low and flag it in seconds. The whole household sees which essentials need restocking — before someone buys the third bottle of dish soap this week."
          />
          <HookCard
            icon="👨‍👩‍👧"
            title="Shared with the whole family"
            body="One list, everyone on it. No more &ldquo;I thought you bought it&rdquo; or the same item twice filling up the cupboard. Grandma, the teens, everyone stays in sync."
          />
          <HookCard
            icon="🧠"
            title="Smart buying"
            badge="Coming soon"
            body="A price-per-unit comparison that tells you which pack size is actually cheaper. On the roadmap — the groundwork is already on-chain."
          />
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Example scenario — the Lee household                             */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-20">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-8 sm:p-10">
          <h2 className="text-center text-2xl font-bold tracking-tight text-slate-100">
            See it in action
          </h2>
          <p className="mt-1 text-center text-sm text-slate-500">
            A typical week with the Lee household
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-sm">
            <Member name="Mom" role="admin" />
            <Member name="Dad" />
            <Member name="Alex" role="teen" />
            <Member name="Grandma" />
          </div>

          <ol className="mx-auto mt-8 max-w-2xl space-y-4">
            <Step
              n={1}
              body={
                <>
                  Mom{" "}
                  <strong className="text-slate-200">sets up Stocksie</strong>{" "}
                  and invites the family.
                </>
              }
            />
            <Step
              n={2}
              body={
                <>
                  Grandma notices the laundry detergent is almost empty and{" "}
                  <strong className="text-slate-200">flags it</strong> on the
                  shared list. 🧴
                </>
              }
            />
            <Step
              n={3}
              body={
                <>
                  Alex checks — turns out Dad{" "}
                  <strong className="text-slate-200">
                    already grabbed one
                  </strong>{" "}
                  yesterday. No double-buy. ✅
                </>
              }
            />
            <Step
              n={4}
              body={
                <>
                  Mom adds it to the list and{" "}
                  <strong className="text-slate-200">
                    approves the restock
                  </strong>
                  . 🛒
                </>
              }
            />
            <Step
              n={5}
              body={
                <>
                  Alex buys it and marks it done. The shared pot{" "}
                  <strong className="text-slate-200">pays Alex back</strong> —
                  no &ldquo;who owes who.&rdquo; 💸
                </>
              }
            />
            <Step
              n={6}
              body={
                <>
                  Everyone sees{" "}
                  <strong className="text-slate-200">
                    what&rsquo;s stocked and what&rsquo;s next
                  </strong>{" "}
                  — at a glance. 📋
                </>
              }
            />
          </ol>

          <p className="mt-8 text-center text-sm text-slate-400">
            The cupboard stays stocked. The money stays fair. No spreadsheets.
            No &ldquo;who owes who&rdquo; texts.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Final CTA                                                       */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-20 text-center">
        <h2 className="text-2xl font-bold tracking-tight text-slate-100">
          Ready to set up your household?
        </h2>
        <p className="mt-2 text-slate-400">
          It takes a minute. Sign in, name your household, invite your family.
        </p>
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="mt-6 rounded-xl bg-emerald-500 px-7 py-3 text-base font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
        >
          Get started &rarr;
        </button>
      </section>

      <footer className="mt-16 border-t border-slate-800 pt-6 text-center text-xs text-slate-600">
        Stocksie runs on the Solana network. Your household&rsquo;s money lives
        in an account only you control.
      </footer>
    </main>
  );
}

/** One of the three "what it helps with" cards. */
function HookCard({
  icon,
  title,
  body,
  badge,
}: {
  icon: string;
  title: string;
  body: string;
  badge?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-6">
      <div className="text-3xl" aria-hidden="true">
        {icon}
      </div>
      <h3 className="mt-4 text-lg font-semibold text-slate-100">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{body}</p>
      {badge ? (
        <span className="mt-4 inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
          {badge}
        </span>
      ) : null}
    </div>
  );
}

/** A household member chip in the example scenario. */
function Member({ name, role }: { name: string; role?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
      <span aria-hidden="true">👤</span>
      <span className="font-medium">{name}</span>
      {role ? <span className="text-slate-500">· {role}</span> : null}
    </span>
  );
}

/** One numbered step in the example scenario walkthrough. */
function Step({ n, body }: { n: number; body: React.ReactNode }) {
  return (
    <li className="flex items-start gap-4">
      <span
        className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-emerald-500/15 text-sm font-semibold text-emerald-300"
        aria-hidden="true"
      >
        {n}
      </span>
      <p className="text-base leading-relaxed text-slate-300">{body}</p>
    </li>
  );
}
