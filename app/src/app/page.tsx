'use client';

import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useProgram } from '@/lib/program';

export default function Home() {
  const { connection } = useConnection();
  const { connected, publicKey, wallet } = useWallet();
  const program = useProgram();

  const endpoint = connection.rpcEndpoint;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stocksie</h1>
          <p className="text-sm text-slate-400">Household coordination on Solana</p>
        </div>
        <WalletMultiButton />
      </header>

      <section className="mt-8 grid gap-4 sm:grid-cols-3">
        <InfoCard label="Cluster" value={endpointLabel(endpoint)} />
        <InfoCard label="Program client" value={program ? 'loaded' : '—'} />
        <InfoCard label="Wallet" value={wallet?.adapter.name ?? 'none'} />
      </section>

      <section className="mt-8 rounded-xl border border-slate-800 bg-slate-900/40 p-6">
        {connected ? (
          <p className="text-sm">
            Connected as <code className="text-emerald-400">{publicKey?.toBase58()}</code>. Instruction
            panels arrive in Stage 4.
          </p>
        ) : (
          <p className="text-sm text-slate-300">
            Connect a wallet — Phantom / Solflare (Wallet Standard) or the built-in{' '}
            <strong>Local Keypair (dev)</strong> — to begin driving the Stocksie program.
          </p>
        )}
      </section>
    </main>
  );
}

function endpointLabel(endpoint: string): string {
  return endpoint.includes('127.0.0.1') || endpoint.includes('localhost')
    ? 'localnet (Surfpool)'
    : endpoint;
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 truncate text-sm font-medium">{value}</div>
    </div>
  );
}
