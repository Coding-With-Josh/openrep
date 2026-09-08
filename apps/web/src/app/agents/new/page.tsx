'use client'

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Loader2, Plus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import AgentAvatar from '@/components/ui/agent-avatar';
import { useGuestSession } from '@/lib/session';
import { invalidateCachePrefix } from '@/lib/client-cache';

import { generateNameBatch } from "@openrep/sdk/names";

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// candidates come from the sdk name module: every reroll draws a fresh
// shuffled batch with no repeated word or name, so the cycle never offers
// the same bot twice until the batch is exhausted.
const NAME_BATCH_SIZE = 8;
const toInputValue = (candidate: string) => candidate.replace(/\.agent$/, "");

type ApiError = { error?: { code?: string; message?: string } };

const Page = () => {
  const router = useRouter();
  const { ready: sessionReady, error: sessionError } = useGuestSession();
  const [candidates, setCandidates] = useState<string[]>(() => generateNameBatch(NAME_BATCH_SIZE));
  const [name, setName] = useState(() => toInputValue(candidates[0]));
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleReroll = () => {
    if (creating) return;
    setError(null);
    const nextIndex = candidateIndex + 1;
    if (nextIndex < candidates.length) {
      setCandidateIndex(nextIndex);
      setName(toInputValue(candidates[nextIndex]));
      return;
    }
    const fresh = generateNameBatch(NAME_BATCH_SIZE);
    setCandidates(fresh);
    setCandidateIndex(0);
    setName(toInputValue(fresh[0]));
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
      // the agent list page still holds a pre-create cached copy; drop it so
      // navigating back refetches and shows the new agent immediately.
      invalidateCachePrefix('agents:');
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
    <div className="bg-white text-black min-h-screen flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden dark:bg-neutral-950 dark:text-neutral-100">
      <div className="relative w-full max-w-lg flex flex-col gap-6 z-10">
        <Link
          href="/agents"
          className="flex items-center gap-2 w-fit text-sm text-neutral-500 hover:text-neutral-700 transition-all duration-200 hover:scale-102 active:scale-98 dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          <ArrowLeft className="w-4 h-4" />
          your agents
        </Link>

        <header className="flex flex-col items-start gap-2">
          <h1 className="text-3xl font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
            create an agent
          </h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            name it, or keep the generated one. agents start at score 0.00.
          </p>
        </header>

        <form onSubmit={handleCreate}>
          <main className="bg-neutral-100/70 p-2 rounded-2xl shadow-sm ring-1 ring-neutral-200/50 dark:bg-white/5 dark:ring-white/10">
            <div className="bg-white rounded-xl p-4 shadow-sm border border-neutral-100 flex flex-col gap-4 dark:bg-black/20 dark:border-neutral-800 dark:shadow-white/5">
              <div className="flex items-center gap-3">
                <div className="size-10 rounded-lg bg-linear-to-br from-neutral-100 to-neutral-200 overflow-hidden shrink-0 dark:from-neutral-800 dark:to-neutral-700">
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
                    className="w-full bg-transparent text-lg font-medium tracking-tight text-neutral-900 placeholder-neutral-400 outline-none disabled:opacity-50 dark:text-neutral-50 dark:placeholder-neutral-500"
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
                    'p-2 rounded-full text-neutral-500 transition-all duration-200 dark:text-neutral-400',
                    creating
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-neutral-100 hover:text-neutral-700 hover:scale-102 active:scale-98 dark:hover:bg-white/10 dark:hover:text-neutral-200'
                  )}
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-medium tracking-tight text-neutral-700 dark:text-neutral-200">
                  score 0.00
                </span>
                <span className="text-xs text-neutral-400">no attestations yet</span>
              </div>

              {error && <p className="text-xs text-rose-600 font-medium dark:text-rose-400">{error}</p>}

              <button
                type="submit"
                disabled={creating}
                className={cn(
                  'w-full flex items-center justify-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium tracking-tight text-white transition-all duration-200 dark:bg-white dark:text-black',
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