# Plan 007 — Web2-Friendly UX Layer 2 (Visual & Layout Warmth)

> Continuation of **plan 005** (Web2-Friendly UX Revision). Layer 1 (vocabulary),
> Layer 0 (landing), and the Path A→B loop (plan 006) are all shipped. This plan
> executes **plan 005 §5 Layer 2** — the visual/layout warmth that turns the
> already-honest UI into the genuinely friendly one.
>
> Cut from `develop` @ `73c826a` onto a new feature branch
> `feature/web2-ux-layer2`.

---

## 1. Context

- **Branch:** `feature/web2-ux-layer2` (cut from `develop`).
- **Goal:** finish the web2-UX arc by removing the two remaining "this looks
  like a developer tool" signals in the UI:
  1. **Cold dark-only theme** + monospace overload (slate-950 black everywhere,
     mono fonts on every number, dashed borders).
  2. **Raw 44-char pubkeys as the primary identifier** — `shortPubkey()` (e.g.
     `7N2q…k9Px`) is still the headline in the member roster + purchase ledger
     + wallet button. Web2 users see a meaningless glyph salad.
- **In scope:** presentation only. Visual chrome, theming, an avatar primitive,
  and card layouts. **No** changes to any `lib/` logic file, any `hooks/` file,
  any `adapters/` file, the Anchor program, any `.methods.*` call, any
  `.accountsStrict({...})` set, or any PDA derivation.
- **Out of scope (explicitly, per plan 005 §6 — those are Layer 3):**
  onboarding stepper, tabbed layout, primary CTA modal, lockable admin cards,
  empty-state illustrations. Layer 3 is a separate future plan.

## 2. Why now (sequencing)

Plan 006 just landed the off-chain shelf + best-value engine + cost-saving
reward as live features (plan 005 §4c's Path B). The landing now tells the
truth: this is a household supply-management product, not a Solana devtool.
But once a user signs in, the dashboard still *looks* like a devtool — dark,
monospace, pubkeys-as-identity. Layer 2 makes the dashboard match the promise
of the landing. This is the lowest-risk, highest-user-perceived-value next
move: no logic changes, no Rust, no new deps beyond a small theme-toggle
cookie helper.

## 3. Non-negotiables (the boundary)

1. **No logic changes.** Layer 2 is presentation only. The acceptance grep
   (§6) must show zero diffs in any `lib/` / `hooks/` / `adapters/` file, and
   zero diffs to any Anchor method call, account set, or PDA derivation.
2. **Dark theme stays as a first-class option.** Developers + existing users
   prefer it; the light theme is the new default for new users, but the toggle
   must be one click and persist across reloads.
3. **No flash of wrong theme.** Theme choice must be applied before first
   paint to avoid a FOUC hydration mismatch. The standard Next.js pattern is a
   blocking inline `<script>` in `<head>` that reads `localStorage` + the
   `prefers-color-scheme` media query and sets `documentElement.classList`
   before React hydrates.
4. **No new heavy deps.** `next-themes` is the canonical lib but pulls a
   runtime dep + a context provider; the inline-script approach is ~30 lines
   of code, no dep, and matches the existing "no runtime lib for trivial
   concerns" discipline (compare `lib/format.ts`, `lib/cn.ts`). Use the
   inline script unless a reviewer objects.
5. **Avatars are deterministic and offline.** Color derived from the pubkey
   via a stable hash (no `Math.random`), initials derived from the pubkey
   (no name service lookup). Must render identically on server and client
   (SSR-safe).
6. **Tables → cards, but keep the data.** The member roster + purchase ledger
   become responsive card grids on mobile and stay as denser card grids on
   desktop. No data column is dropped — it's a layout change, not an
   information change. The wallet admin still sees every pubkey via a `title`
   tooltip on the avatar (existing pattern in `StateView.tsx`).

## 4. Architecture

### 4.1 Theme system (no runtime dep)

Two files:

- **`app/src/app/theme-script.ts`** — exports a single string constant
  `themeInitScript` containing the blocking inline JS:
  ```js
  (function () {
    try {
      var stored = localStorage.getItem('stocksie-theme');
      var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      var theme = stored || (prefersDark ? 'dark' : 'light');
      if (theme === 'dark') document.documentElement.classList.add('dark');
    } catch (e) {}
  })();
  ```
  Injected into `app/src/app/layout.tsx` as
  `<script dangerouslySetInnerHTML={{ __html: themeInitScript }} />` inside
  `<head>`, ahead of any styled content.
- **`app/src/lib/theme.ts`** — three pure helpers + a tiny React hook
  `useTheme()`:
  - `getTheme(): 'light' | 'dark'` — reads `documentElement.classList`
    (SSR-safe: returns `'dark'` on the server, since that's the historical
    default and the inline script corrects it before paint on the client).
  - `setTheme(t)` — toggles the class + writes `localStorage`.
  - `useTheme()` — `useState` + `useEffect` wrapper; returns `{ theme,
    setTheme, toggle }`.

Tailwind config gets `darkMode: 'class'` (it currently has no `darkMode`
key, so the default `media` strategy applies — switching to `class` is what
makes the toggle work).

### 4.2 Avatar primitive

- **`app/src/lib/avatar.ts`** — pure, SSR-safe:
  - `avatarColor(seed: string): { bg: string; text: string }` — maps the
    seed (pubkey base58) to one of ~8 pastel pairs from a fixed palette
    via a stable 8-bit hash (`seed.charCodeAt` accumulation mod palette
    length — no `Math.random`, no `crypto` dep, deterministic across server
    and client).
  - `avatarInitials(seed: string): string` — first 1–2 non-zero chars of
    the base58 string (base58 has no `0`, `O`, `I`, `l`, so this is always
    a readable glyph).
- **`app/src/components/ui/Avatar.tsx`** — `<Avatar seed={pubkey} size?>`
  renders a rounded square with the deterministic bg/text + the initials,
  and a `title={fullAddress}` tooltip for power users. Sizes: `sm` (24px),
  `md` (32px), `lg` (40px).

### 4.3 Layout: tables → responsive card grids

The existing `MemberRoster` and `PurchaseLedger` in `StateView.tsx` render
`<table>`s. Layer 2 replaces them with card grids:

- **`MemberCard`** — avatar (lg) + role badge + reward points + active pill +
  short pubkey as a muted secondary line. Grid: 1 col mobile, 2 col sm, 3 col
  lg.
- **`PurchaseCard`** — `#id` + status pill header, then buyer avatar + short
  pubkey, then a 3-cell mini-grid (spending limit / paid back / reward).
  Grid: 1 col mobile, 2 col lg.

The `title={fullAddress}` tooltip pattern (already used in the current
`MemberRow`/`RequestRow`) is preserved on the avatar — full pubkey is one
hover away for any admin who needs it.

### 4.4 Color palette

Light theme: soft warm neutrals. Map the existing `slate-*` scale to a warm
`stone-*` / `amber-*` accent:

| Surface | Dark (existing) | Light (new default) |
|---|---|---|
| Page bg | `bg-slate-950` | `bg-stone-50` |
| Card bg | `bg-slate-900/40` | `bg-white` |
| Border | `border-slate-800` | `border-stone-200` |
| Body text | `text-slate-100` | `text-stone-800` |
| Muted text | `text-slate-400` | `text-stone-500` |
| Accent | `emerald-400` | `emerald-600` |
| Code/mono | `text-slate-300` | `text-stone-600` |

Implementation: every colored class in the components gets a `dark:` variant.
The `globals.css` `body` rule becomes `@apply bg-stone-50 text-stone-800
dark:bg-slate-950 dark:text-slate-100 antialiased;` and `:root { color-scheme:
dark; }` becomes `:root { color-scheme: light; } .dark { color-scheme: dark; }`.

### 4.5 Icons in panel headers

Plan 005 §5.6 calls for 🏠 💰 🛒 🎁 in panel headers. `Panel.tsx` gains an
optional `icon?: ReactNode` prop rendered before the title. Dashboard header
already uses 🏠; the five panels get:

- `HouseholdPanel` → 🏠
- `FundsPanel` → 💰
- `PurchasePanel` → 🛒
- `ReimbursePanel` → 💸
- `RewardsPanel` → 🎁

### 4.6 Wallet button chrome + connected state

Plan 005 §5.7 calls for re-skinning the wallet button + replacing the
connected-state truncated address with an avatar + name. The labels were
already overridden in Layer 1 (§1.10a); Layer 2 finishes the visual:

- `WalletButton.tsx` renders `<BaseWalletMultiButton>` with the existing
  `labels` override, plus Tailwind classes that override the adapter's
  default chrome (the adapter CSS is still imported for the modal — only
  the button itself gets re-skinned).
- In the connected state, render a custom child: `<Avatar seed={publicKey}>
  + "Signed in"` (or the wallet adapter name if available). The adapter's
  default truncated-address display is replaced.

## 5. Phased tasks

### Phase A — Theme system (foundation, no visual change yet)

- [ ] **A.1** `app/src/lib/theme.ts` — `getTheme` / `setTheme` / `useTheme`
  hook. SSR-safe (`getTheme` returns `'dark'` on server; the inline script
  corrects before paint). Unit tests in `app/src/lib/theme.test.ts`: 4–6
  tests covering the SSR return, the classList toggle, the localStorage
  write, and the no-`window` guard.
- [ ] **A.2** `app/src/app/theme-script.ts` — export `themeInitScript`
  string. No tests (it's a string); a code comment documents the FOUC
  invariant.
- [ ] **A.3** `app/src/app/layout.tsx` — inject the script in `<head>` ahead
  of styled content. Keep the existing `suppressHydrationWarning` on
  `<html>`/`<body>` (still needed for browser-extension attrs, independent
  of theme).
- [ ] **A.4** `app/tailwind.config.ts` — add `darkMode: 'class'`. No content
  change.
- [ ] **A.5** `app/src/app/globals.css` — flip the `body` rule + the
  `:root` `color-scheme` to light-default + dark-variant (§4.4).
- [ ] **A.6** Verify: `pnpm -C app typecheck` → exit 0; `pnpm -C app build`
  → exit 0; `pnpm -C app test` → all green incl. new theme tests. Eyeball:
  page renders light by default, dark when `.dark` is on `<html>`, no FOUC
  on hard refresh.

### Phase B — Avatar primitive (pure, fully testable)

- [ ] **B.1** `app/src/lib/avatar.ts` — `avatarColor` + `avatarInitials`.
  Pure, no React, no DOM. Unit tests in `app/src/lib/avatar.test.ts`:
  - `avatarColor` deterministic (same seed → same color, across calls).
  - `avatarColor` covers all palette entries over a spread of seeds.
  - `avatarColor` stable across server/client (no `Math.random`, no `Date`).
  - `avatarInitials` returns 1–2 readable chars; never returns a base58-
    excluded glyph (`0`, `O`, `I`, `l`).
- [ ] **B.2** `app/src/components/ui/Avatar.tsx` — the component. Props:
  `seed: string`, `size?: 'sm' | 'md' | 'lg'`, `title?` (defaults to seed),
  `className?`. SSR-safe (uses the pure lib helpers, no `useEffect`).
- [ ] **B.3** Verify: typecheck + build + test green. Snapshot-eyeball the
  three sizes.

### Phase C — ThemeToggle + dashboard header refresh

- [ ] **C.1** `app/src/components/ui/ThemeToggle.tsx` — a small button
  (🌞 / 🌙) wired to `useTheme().toggle`. SSR-safe via the
  `if (!mounted) return null;` mount-guard pattern (same pattern as
  `WalletButton.tsx` — avoids hydration mismatch on the icon).
- [ ] **C.2** `app/src/components/Dashboard.tsx` — add `<ThemeToggle />` to
  the header action row (next to Shelf / Scan / WalletButton). No other
  dashboard change in this phase.
- [ ] **C.3** Verify: typecheck + build green. Eyeball: toggle flips theme,
  persists across reload, no FOUC.

### Phase D — Color migration (the big mechanical pass)

Apply `dark:` variants to every colored class in the component tree so the
light theme is fully styled. This is the largest single phase by line count
but the lowest-risk by logic — it's class-string edits.

- [ ] **D.1** `app/src/components/ui/*` — Panel, Badge, Button, Field,
  Select, Modal, ConnectGate, ResultBanner. Each gets `dark:` variants on
  every `bg-*` / `text-*` / `border-*` / `ring-*` class.
- [ ] **D.2** `app/src/components/StateView.tsx` — StatCard, MetaRow,
  EmptyState, LoadingState, ErrorState. Same treatment.
- [ ] **D.3** `app/src/components/panels/*` — all 5 panels. Same treatment.
- [ ] **D.4** `app/src/components/BestValueModal.tsx`, `Landing.tsx`,
  `Dashboard.tsx`, `WalletButton.tsx`. Same treatment.
- [ ] **D.5** `app/src/components/shelf/*` + `app/src/components/scan/*` —
  same treatment (don't forget these — plan 006 surfaces must match).
- [ ] **D.6** Verify: typecheck + build green. Eyeball light + dark on
  `/`, `/shelf`, `/scan`, and the dashboard (signed in).

### Phase E — Tables → card grids (MemberRoster + PurchaseLedger)

- [ ] **E.1** `app/src/components/StateView.tsx` — replace `MemberRoster`'s
  `<table>` with a responsive card grid of `<MemberCard>` (new local
  component in the same file). Each card: avatar (lg) + role badge + reward
  points + active pill + short pubkey muted line. `title={fullAddress}` on
  the avatar preserves the power-user tooltip.
- [ ] **E.2** `app/src/components/StateView.tsx` — replace `PurchaseLedger`'s
  `<table>` with a card grid of `<PurchaseCard>` (new local component). Each
  card: `#id` + status pill header row, buyer avatar + short pubkey, then a
  3-cell mini-grid (spending limit / paid back / reward).
- [ ] **E.3** Delete the now-unused `MemberRow` + `RequestRow` helpers
  (they only existed to render `<tr>`s). Keep `sortMembers` + `sortRequests`
  (the card grids still consume the sorted arrays).
- [ ] **E.4** Verify: typecheck + build green. Eyeball: roster + ledger
  render as cards, all data still present, responsive at mobile / sm / lg.

### Phase F — Wallet button chrome + panel icons + closeout

- [ ] **F.1** `app/src/components/WalletButton.tsx` — re-skin the connected
  state: render `<Avatar seed={publicKey}>` + a friendly label (the wallet
  adapter name if available, else "Signed in") inside the button, replacing
  the adapter's default truncated-address display. Keep the `labels`
  override from Layer 1 §1.10a.
- [ ] **F.2** `app/src/components/ui/Panel.tsx` — add optional `icon?`
  prop rendered before the title.
- [ ] **F.3** Pass the icon to each of the 5 panels per §4.5.
- [ ] **F.4** `docs/ROADMAP.md` — add a "Visual warmth (web2 Layer 2) —
  shipped post-MVP" entry under §1's off-chain client surface subsection.
- [ ] **F.5** `.plans/005_web2_ux.md` §5 — mark Layer 2 DONE; §8 — add a
  Layer 2 verification log subsection; §9 — note Layer 2 shipped via plan 007.
- [ ] **F.6** This plan's §7 status + §8 bundle row + handover doc.
- [ ] **F.7** Verify all gates (§6). Conventional commit.

## 6. Verification gates (definition of done)

1. `pnpm -C app typecheck` → exit 0.
2. `pnpm -C app build` → exit 0. Track First Load JS for `/`, `/shelf`,
   `/scan`, and the dashboard route in §7 (expect a small uptick from the
   avatar + theme code; flag if any route jumps > 5 kB).
3. `pnpm -C app test` → all green, including new `theme.test.ts` +
   `avatar.test.ts`.
4. `cargo check -p stocksie` → exit 0 (sanity — no Rust touched).
5. **Scope-of-change audit:** `git diff --stat develop...feature/web2-ux-layer2`
   must show **zero** diffs in `app/src/lib/` (except the two new files
   `theme.ts` + `avatar.ts` + their test files), `app/src/hooks/`,
   `app/src/lib/adapters/`, or `programs/`. Every other diff is under
   `app/src/components/`, `app/src/app/`, `app/src/lib/theme.ts`,
   `app/src/lib/avatar.ts`, `app/tailwind.config.ts`, `docs/`, or the plan
   files.
6. **Logic-untouched grep:** `rg "\.methods\.|accountsStrict|derivePda|pda\("`
   over the diff must return **zero new lines** vs `develop` (these calls
   exist already; Layer 2 adds none).
7. **No FOUC:** hard-refresh `/` in a browser with no `localStorage` value —
   the page must render in the correct theme on first paint, no dark→light
   flash.
8. **SSR-safe avatars:** view-source on `/` (signed-out landing renders on
   the server) — no `Math.random` / `Date.now` / `window` references in the
   avatar output. The avatar color is deterministic from the seed.

## 7. Bundle size tracking (fill in per phase)

| Phase | `/` First Load | `/shelf` | `/scan` | Dashboard | Notes |
|---|---|---|---|---|---|
| Baseline (develop @ 73c826a) | 73 kB / 270 kB | 117 kB | 109 kB | (part of `/`) | From plan 006 §7 |
| A | — | — | — | — | (fill in) |
| B | — | — | — | — | (fill in) |
| C | — | — | — | — | (fill in) |
| D | — | — | — | — | (fill in) |
| E | — | — | — | — | (fill in) |
| F | — | — | — | — | (fill in) |

## 8. Status

**Not started.** Awaiting go-ahead to cut `feature/web2-ux-layer2` from
`develop` @ `73c826a` and begin Phase A.

## 9. Open questions (need PO input before/during build)

- **Q1 — `next-themes` vs inline script.** Default: inline script (§4.1),
  zero deps. If the PO prefers the canonical `next-themes` lib (more
  features: system theme detection, `forcedTheme`, SSR helpers), say so
  before Phase A.
- **Q2 — Avatar shape.** Default: rounded square (matches the existing card
  aesthetic). Alternative: circle (more "social app"). Say so before Phase B.
- **Q3 — Avatar palette.** Default: 8 pastel pairs (§4.2). Alternative: a
  larger 16-pair palette for more visual variety in big households (max 16
  members per the on-chain constraint, so 16 pairs guarantees uniqueness is
  *possible* — though not guaranteed, since the hash is mod palette length).
  Default 8 is fine; flag if you want 16.
- **Q4 — Purchase card density.** Default: one card per request, 2-col grid
  on desktop. Alternative: keep a denser table on desktop + cards on mobile
  only. Default is simpler (one layout, responsive). Flag if you want the
  hybrid.
