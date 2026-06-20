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
//                   and smart buying (the comparison engine now ships).
//   3. Example    — two concrete worked scenarios that turn the abstract
//                   product into something tangible: the Neo family (a
//                   Japanese household in Brooklyn) and a shared house
//                   (four housemates in San Francisco). Toggle between them
//                   to compare. Ages are kept in the 15–50 range — the
//                   realistic demographic for a self-custody wallet.
//   4. Final CTA  — a second entry point for users who scrolled to the bottom.
//
// Marketing surface. Interactions are limited to "Get started →" (which opens
// the wallet picker modal via `useWalletModal`) and the scenario toggle (pure
// client-side UI state — `family` vs `sharehouse`). No networking, no on-chain
// calls. Once a wallet connects, `page.tsx` swaps this out for the dashboard.

import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useState } from "react";
import { WalletButton } from "@/components/WalletButton";

export function Landing() {
  const { setVisible } = useWalletModal();
  const [scenario, setScenario] = useState<"family" | "sharehouse">("family");

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      {/* --------------------------------------------------------------- */}
      {/* Minimal header — logo + always-available sign-in affordance      */}
      {/* --------------------------------------------------------------- */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-xl font-semibold tracking-tight text-stone-800 dark:text-slate-100">
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
          <span className="text-emerald-600 dark:text-emerald-400">
            and never double-buy
          </span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-stone-500 dark:text-slate-400">
          Your family&rsquo;s shared list for household essentials. Everyone
          knows what&rsquo;s running low, what&rsquo;s already bought, and what
          to grab next.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => setVisible(true)}
            className="rounded-xl bg-emerald-500 px-7 py-3 text-base font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-500 dark:hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950"
          >
            Get started &rarr;
          </button>
          <p className="text-xs text-stone-500 dark:text-slate-500">
            Sign in with Phantom, Solflare, Backpack — or the built-in dev
            account to try it locally.
          </p>
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Hook — three "what it helps with" cards                          */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-20">
        <h2 className="text-center text-sm font-semibold uppercase tracking-widest text-stone-500 dark:text-slate-500">
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
            title="Shared with the whole household"
            body="One list, everyone on it. No more &ldquo;I thought you bought it&rdquo; or the same item twice filling up the cupboard. Family or housemates — everyone stays in sync."
          />
          <HookCard
            icon="🧠"
            title="Smart buying"
            body="A price-per-unit comparison that tells you which pack size is actually cheaper — and rewards the buyer when they beat the benchmark. Compare offers at a glance before you approve."
          />
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Example scenarios — toggle the Neo family ↔ a shared house        */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-20">
        <div className="rounded-2xl border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-8 sm:p-10">
          <h2 className="text-center text-2xl font-bold tracking-tight text-stone-800 dark:text-slate-100">
            See it in action
          </h2>
          <p className="mt-1 text-center text-sm text-stone-500 dark:text-slate-500">
            Two ways households use Stocksie — pick the one that looks like
            yours
          </p>

          <div className="mt-8 flex flex-wrap justify-center gap-2">
            <ScenarioTab
              active={scenario === "family"}
              onClick={() => setScenario("family")}
              icon="🏠"
              label="Family home"
            />
            <ScenarioTab
              active={scenario === "sharehouse"}
              onClick={() => setScenario("sharehouse")}
              icon="🛋️"
              label="Shared house"
            />
          </div>

          {scenario === "family" ? (
            <NeoHouseScenario />
          ) : (
            <SharedHouseScenario />
          )}
        </div>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* Final CTA                                                       */}
      {/* --------------------------------------------------------------- */}
      <section className="mt-20 text-center">
        <h2 className="text-2xl font-bold tracking-tight text-stone-800 dark:text-slate-100">
          Ready to set up your household?
        </h2>
        <p className="mt-2 text-stone-500 dark:text-slate-400">
          It takes a minute. Sign in, name your household, invite your family.
        </p>
        <button
          type="button"
          onClick={() => setVisible(true)}
          className="mt-6 rounded-xl bg-emerald-500 px-7 py-3 text-base font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 transition hover:bg-emerald-500 dark:hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950"
        >
          Get started &rarr;
        </button>
      </section>

      <footer className="mt-16 border-t border-stone-200 dark:border-slate-800 pt-6 text-center text-xs text-stone-400 dark:text-slate-600">
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
    <div className="rounded-2xl border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-900/40 p-6">
      <div className="text-3xl" aria-hidden="true">
        {icon}
      </div>
      <h3 className="mt-4 text-lg font-semibold text-stone-800 dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-slate-400">
        {body}
      </p>
      {badge ? (
        <span className="mt-4 inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-300">
          {badge}
        </span>
      ) : null}
    </div>
  );
}

/** A household member chip in the example scenario. */
function Member({ name, role }: { name: string; role?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 dark:border-slate-700 bg-stone-100/80 dark:bg-slate-900/60 px-3 py-1 text-xs text-stone-600 dark:text-slate-300">
      <span aria-hidden="true">👤</span>
      <span className="font-medium">{name}</span>
      {role ? (
        <span className="text-stone-500 dark:text-slate-500">· {role}</span>
      ) : null}
    </span>
  );
}

/** One numbered step in the example scenario walkthrough. */
function Step({ n, body }: { n: number; body: React.ReactNode }) {
  return (
    <li className="flex items-start gap-4">
      <span
        className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-emerald-50 dark:bg-emerald-500/15 text-sm font-semibold text-emerald-600 dark:text-emerald-300"
        aria-hidden="true"
      >
        {n}
      </span>
      <p className="text-base leading-relaxed text-stone-600 dark:text-slate-300">
        {body}
      </p>
    </li>
  );
}

/** One of the two scenario picker tabs. */
function ScenarioTab({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: string;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "inline-flex items-center gap-2 rounded-full border border-emerald-500 bg-emerald-50 dark:border-emerald-400 dark:bg-emerald-500/15 px-4 py-2 text-sm font-medium text-emerald-700 dark:text-emerald-300"
          : "inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-600 hover:border-stone-400 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-600"
      }
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

/**
 * The Neo family scenario — a Japanese household making a home in Brooklyn.
 * All members are in the 15–50 band, the realistic demographic for a
 * self-custody Solana wallet (no elderly / no small children).
 */
function NeoHouseScenario() {
  return (
    <div className="mt-8">
      <p className="text-center text-sm text-stone-500 dark:text-slate-400">
        A typical week with the{" "}
        <strong className="text-stone-700 dark:text-slate-200">
          Neo family
        </strong>{" "}
        — a Japanese household making a home in Brooklyn
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm">
        <Member name="Takeshi" role="dad · admin" />
        <Member name="Yuki" role="mom" />
        <Member name="Mika" role="daughter · 21" />
        <Member name="Ken" role="son · 17" />
      </div>

      <ol className="mx-auto mt-8 max-w-2xl space-y-4">
        <Step
          n={1}
          body={
            <>
              Takeshi{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                sets up Stocksie
              </strong>{" "}
              and invites the family.
            </>
          }
        />
        <Step
          n={2}
          body={
            <>
              Ken notices the laundry detergent is almost empty and{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                flags it
              </strong>{" "}
              on the shared list. 🧴
            </>
          }
        />
        <Step
          n={3}
          body={
            <>
              Mika checks — turns out Takeshi{" "}
              <strong className="text-stone-700 dark:text-slate-200">
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
              Yuki adds it to the next restock and{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                approves it
              </strong>
              . 🛒
            </>
          }
        />
        <Step
          n={5}
          body={
            <>
              Ken buys it and marks it done. The shared pot{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                pays Ken back
              </strong>{" "}
              — no &ldquo;who owes who.&rdquo; 💸
            </>
          }
        />
        <Step
          n={6}
          body={
            <>
              Everyone sees{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                what&rsquo;s stocked and what&rsquo;s next
              </strong>{" "}
              — at a glance. 📋
            </>
          }
        />
      </ol>

      <p className="mt-8 text-center text-sm text-stone-500 dark:text-slate-400">
        The cupboard stays stocked. The money stays fair. No spreadsheets. No
        &ldquo;who owes who&rdquo; texts.
      </p>
    </div>
  );
}

/**
 * The Sunset Sharehouse scenario — four housemates co-living in San Francisco.
 * Models the non-family use case: rent-adjacent essentials split N ways,
 * where the &ldquo;admin&rdquo; is just whoever set up the house, not a parent.
 */
function SharedHouseScenario() {
  return (
    <div className="mt-8">
      <p className="text-center text-sm text-stone-500 dark:text-slate-400">
        A typical week at the{" "}
        <strong className="text-stone-700 dark:text-slate-200">
          Sunset Sharehouse
        </strong>{" "}
        — four housemates in San Francisco
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm">
        <Member name="Emi" role="admin" />
        <Member name="Jake" />
        <Member name="Priya" />
        <Member name="Sam" />
      </div>

      <ol className="mx-auto mt-8 max-w-2xl space-y-4">
        <Step
          n={1}
          body={
            <>
              Emi{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                sets up Stocksie
              </strong>{" "}
              and invites the housemates — split four ways from day one.
            </>
          }
        />
        <Step
          n={2}
          body={
            <>
              Jake notices the toilet paper is almost out and{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                flags it
              </strong>{" "}
              on the shared list. 🧻
            </>
          }
        />
        <Step
          n={3}
          body={
            <>
              Priya checks — Sam{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                already grabbed a pack
              </strong>{" "}
              on the way home. No double-buy. ✅
            </>
          }
        />
        <Step
          n={4}
          body={
            <>
              The next restock (coffee, dish soap…) lands on the list and{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                anyone can approve
              </strong>
              . 🛒
            </>
          }
        />
        <Step
          n={5}
          body={
            <>
              Jake buys it and marks it done. The shared pot{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                pays Jake back
              </strong>{" "}
              — split four ways, no IOUs. 💸
            </>
          }
        />
        <Step
          n={6}
          body={
            <>
              Everyone sees{" "}
              <strong className="text-stone-700 dark:text-slate-200">
                what&rsquo;s stocked, what&rsquo;s low, who paid last
              </strong>{" "}
              — at a glance. 📋
            </>
          }
        />
      </ol>

      <p className="mt-8 text-center text-sm text-stone-500 dark:text-slate-400">
        No more fridge IOU notes. No more &ldquo;I bought it last time&rdquo;
        arguments. The house stays stocked. The split stays fair.
      </p>
    </div>
  );
}
