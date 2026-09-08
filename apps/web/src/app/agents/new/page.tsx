'use client'

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Plus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import AgentAvatar from '@/components/ui/agent-avatar';
import { useGuestSession } from '@/lib/session';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const NAME_CANDIDATES = [
  'beautiful-pig-black',
  'curious-otter-blue',
  'silent-owl-green',
  'brave-fox-red',
  'gentle-dove-white',
  'lucky-cat-gold',
];

const pickCandidate = (current: string | null) => {
  const pool = NAME_CANDIDATES.filter((n) => n !== current);
  return pool[Math.floor(Math.random() * pool.length)];
};

type ApiError = { error?: { code?: string; message?: string } };

const Page = () => {
  const router = useRouter();
  const { ready: sessionReady, error: sessionError } = useGuestSession();
  const [name, setName] = useState(() => pickCandidate(null));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleReroll = () => {
    if (creating) return;
    setError(null);
    setName(pickCandidate(name));
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating) return;
    setError(null);
    if (!sessionReady) {
      setError(sessionError ?? 'session is not ready yet, try again');
      return;
    }
    const trimmed = name.trim().toLowerCase();
    if (trimmed.length > 0 && !NAME_RE.test(trimmed)) {
      setError('name must be lowercase letters, digits and hyphens, e.g. lucky-cat-gold');
      return;
    }
    setCreating(true);
    try {
      // the server is the authority on name validity and uniqueness; an empty
      // name means the server auto-generates one. the .agent suffix is a
      // server-side contract, appended here so a typed name actually saves.
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trimmed.length > 0 ? { name: `${trimmed}.agent` } : {}),
      });
      const body: AgentManifest | ApiError = await res.json();
      if (!res.ok) {
        setError((body as ApiError).error?.message ?? 'could not create the agent, try again');
        return;
      }
      const created = body as AgentManifest;
      // pass the created display name straight to the next route so the
      // header and avatar render instantly instead of waiting on a fetch.
      router.push(
        `/agents/${encodeURIComponent(created.publicKey)}?name=${encodeURIComponent(
          created.name.replace(/\.agent$/, ''),
        )}`,
      );
    } catch {
      setError('could not reach the server, check your connection');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="bg-white text-black min-h-screen flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden">
      <div className="relative w-full max-w-lg flex flex-col gap-6 z-10">
        <Link
          href="/agents"
          className="flex items-center gap-2 w-fit text-sm text-neutral-500 hover:text-neutral-700 transition-all duration-200 hover:scale-102 active:scale-98"
        >
          <ArrowLeft className="w-4 h-4" />
          your agents
        </Link>

        <header className="flex flex-col items-start gap-2">
          <h1 className="text-3xl font-medium tracking-tight text-neutral-900">
            create an agent
          </h1>
          <p className="text-sm text-neutral-500">
            name it, or keep the generated one. agents start at score 0.00.
          </p>
        </header>

        <form onSubmit={handleCreate}>
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50">
            <div className="bg-white rounded-xl p-4 shadow-sm border border-neutral-100 flex flex-col gap-4">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden shrink-0">
                  <AgentAvatar name={name} className="w-full h-full" />
                </div>
                <div className="flex-1 min-w-0">
                  <input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''));
                      setError(null);
                    }}
                    disabled={creating}
                    spellCheck={false}
                    placeholder="word-word-word"
                    className="w-full bg-transparent text-lg font-medium tracking-tight text-neutral-900 placeholder-neutral-400 outline-none disabled:opacity-50"
                  />
                  <p className="text-xs text-neutral-400 mt-0.5">
                    lowercase letters, digits and hyphens, no spaces
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleReroll}
                  disabled={creating}
                  aria-label="Reroll name"
                  className={cn(
                    'p-2 rounded-full text-neutral-500 transition-all duration-200',
                    creating
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-neutral-100 hover:text-neutral-700 hover:scale-102 active:scale-98'
                  )}
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-medium tracking-tight text-neutral-700">
                  score 0.00
                </span>
                <span className="text-xs text-neutral-400">no attestations yet</span>
              </div>

              {error && <p className="text-xs text-rose-600 font-medium">{error}</p>}

              <button
                type="submit"
                disabled={creating}
                className={cn(
                  'w-full flex items-center justify-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium tracking-tight text-white transition-all duration-200',
                  creating ? 'opacity-60 cursor-not-allowed' : 'hover:scale-102 active:scale-98'
                )}
              >
                {creating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    creating…
                  </>
                ) : (
                  <>
                    <Plus className="w-4 h-4" strokeWidth={2.5} />
                    create agent
                  </>
                )}
              </button>
            </div>
          </main>
        </form>

        <p className="text-xs text-neutral-400 text-center">
          your first chat writes the first attestation and moves the score
        </p>
      </div>
    </div>
  );
};

type AgentManifest = {
  name: string;
  publicKey: string;
  ownerPublicKey: string;
  memoryPointer: string | null;
  permissions: string[];
  createdAt: string;
  manifestVersion: number;
  signature: string;
};

export default Page;