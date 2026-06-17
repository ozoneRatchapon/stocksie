// Synchronizes the Anchor-generated program artifacts (IDL JSON + TypeScript
// type definitions) from the workspace `target/` directory into the frontend
// so the typed client can import them.
//
// Why a script instead of a symlink: the Next.js bundler resolves modules
// through the configured `tsconfig.json` path aliases (`@idl/*`), and a plain
// copy keeps the frontend self-contained and platform-agnostic (no symlink
// permission quirks on Windows, no repo-root coupling at runtime).
//
// Runs automatically before `dev`, `build`, and `typecheck` (see package.json).
// Safe to run repeatedly — overwrites without prompting.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');       // .../stocksie/app
const repoRoot = resolve(appRoot, '..');          // .../stocksie

// (source, destination) pairs, both relative to their respective roots.
const artifacts = [
  {
    description: 'IDL JSON (runtime program definition)',
    source: resolve(repoRoot, 'target/idl/stocksie.json'),
    destination: resolve(appRoot, 'idl/stocksie.json'),
  },
  {
    description: 'generated TypeScript IDL type (Stocksie)',
    source: resolve(repoRoot, 'target/types/stocksie.ts'),
    destination: resolve(appRoot, 'src/lib/generated/stocksie.ts'),
  },
];

let copied = 0;
let skipped = 0;

for (const artifact of artifacts) {
  if (!existsSync(artifact.source)) {
    console.warn(
      `[copy-idl] SKIP ${artifact.description}\n` +
        `  source not found: ${artifact.source}\n` +
        `  hint: run \`anchor build\` (or \`cargo build-sbf\`) at the repo root first.`,
    );
    skipped += 1;
    continue;
  }

  mkdirSync(dirname(artifact.destination), { recursive: true });
  copyFileSync(artifact.source, artifact.destination);
  console.log(`[copy-idl] OK   ${artifact.description}`);
  console.log(`            ${artifact.source}`);
  console.log(`         -> ${artifact.destination}`);
  copied += 1;
}

if (skipped > 0) {
  console.warn(
    `[copy-idl] completed with ${copied} copied, ${skipped} skipped. ` +
      `Type-checking or building against a missing artifact will fail.`,
  );
  // Exit non-zero so `next build` / `tsc` chained after this surface the gap
  // rather than silently building a broken client.
  process.exit(1);
}

console.log(`[copy-idl] done (${copied} artifact${copied === 1 ? '' : 's'}).`);
